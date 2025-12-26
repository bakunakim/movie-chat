require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- Supabase Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Cloudinary Setup ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'movie-chat-avatars',
        allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp']
    }
});

const upload = multer({ storage: storage });

// --- Web Push ---
const publicVapidKey = 'BAxK5ujR9uXmjc5YlNV2k5L5tJf5cts_Chdegh-NSCzRlJp9pGJnPIM3s-sWOTl6Zv8S062nP5D2wYuOPftdWUQ';
const privateVapidKey = 'NFXvDNGrE7N5UB2Y_Zu3jp7pC_6CyPyXfZByQzZ8Tw0';

webpush.setVapidDetails('mailto:example@yourdomain.org', publicVapidKey, privateVapidKey);

const subscriptions = {};

// Ensure public directory is correct and static files are served
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Allow JSON body for non-file requests

// --- Avatar Upload Endpoint ---
app.post('/api/upload-avatar', upload.single('image'), async (req, res) => {
    try {
        const file = req.file;
        const nickname = req.body.nickname;

        if (!file || !nickname) {
            return res.status(400).json({ error: 'Missing file or nickname' });
        }

        // Update User in Supabase with Cloudinary URL
        const { error } = await supabase
            .from('users')
            .update({ avatar_url: file.path })
            .eq('nickname', nickname);

        if (error) throw error;

        // Broadcast update to real-time clients
        io.emit('profile_updated', { nickname, image: file.path });

        res.json({ success: true, url: file.path });
    } catch (err) {
        console.error('Upload Error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});


io.on('connection', (socket) => {

    // --- Login ---
    socket.on('login', async ({ username, password }) => {
        try {
            const { data: user, error } = await supabase.from('users').select('*').eq('nickname', username).single();

            // Auto-signup logic
            let success = false;
            let avatarUrl = null;

            if (!user) {
                // If user doesn't exist, create them
                const { error: createErr } = await supabase.from('users').insert([{ nickname: username, password }]);
                if (!createErr) success = true;
            } else if (user.password === password) {
                success = true;
                avatarUrl = user.avatar_url; // Load from DB
            }

            if (success) {
                socket.username = username;
                socket.emit('login_success', { username, avatar: avatarUrl });
                sendRoomList(socket);
            } else {
                socket.emit('login_fail', 'Login Failed');
            }
        } catch (e) {
            console.error(e);
            socket.emit('login_fail', 'Server Error');
        }
    });

    // --- Registry (Legacy/Socket fallbacks removed or simplified) ---
    // The main upload logic is now handled via POST /api/upload-avatar

    // --- Messaging ---
    socket.on('send_message', async ({ roomId, content }) => {
        if (!socket.username) return;

        let finalContent = content;

        // Fetch latest avatar from DB (Authority)
        // We can optimize this by caching on socket, but DB is safer for persistence
        let userAvatar = null;
        try {
            const { data: u } = await supabase.from('users').select('avatar_url').eq('nickname', socket.username).single();
            if (u) userAvatar = u.avatar_url;
        } catch (e) { }

        try {
            const parsed = JSON.parse(content);
            parsed.meta = parsed.meta || {};
            parsed.meta.nickname = socket.username;

            // Inject Authority Avatar
            if (userAvatar) {
                parsed.meta.avatar = userAvatar;
            }
            finalContent = JSON.stringify(parsed);
        } catch (e) { }

        // Save to DB
        const { data, error } = await supabase
            .from('messages')
            .insert([{ room_id: roomId, nickname: socket.username, content: finalContent }])
            .select();

        if (!error && data) {
            const newMsg = data[0];
            const payload = {
                id: newMsg.id,
                room_id: newMsg.room_id,
                username: newMsg.nickname,
                content: newMsg.content,
                timestamp: newMsg.created_at
            };
            io.to(roomId).emit('new_message', payload);

            // Push Notification
            sendPush(socket.username, finalContent, roomId);
        }
    });

    // --- Rooms & Delete ---
    socket.on('create_room', async (t) => {
        const { data } = await supabase.from('rooms').insert([{ title: t }]).select();
        if (data) io.emit('room_created', data[0]);
    });

    socket.on('join_room', async (rid) => {
        socket.join(rid);
        const safeRid = String(rid);

        const { data: room } = await supabase.from('rooms').select('title').eq('id', safeRid).single();
        if (room) {
            socket.emit('joined_room', { id: safeRid, title: room.title });

            const { data: msgs } = await supabase.from('messages').select('*').eq('room_id', safeRid).order('created_at');
            if (msgs) {
                // Collect unique nicknames involved in this history
                const nicknames = [...new Set(msgs.map(m => m.nickname))];

                // Fetch latest avatars for these users
                const { data: users } = await supabase
                    .from('users')
                    .select('nickname, avatar_url')
                    .in('nickname', nicknames);

                // Create a lookup map: { nickname: avatar_url }
                const avatarMap = {};
                if (users) {
                    users.forEach(u => {
                        if (u.avatar_url) avatarMap[u.nickname] = u.avatar_url;
                    });
                }

                // Inject auth avatars into the message content
                const normalized = msgs.map(m => {
                    let finalContent = m.content;
                    try {
                        const parsed = JSON.parse(m.content);
                        // If we have a fresh avatar for this user, inject it
                        if (avatarMap[m.nickname]) {
                            parsed.meta = parsed.meta || {};
                            parsed.meta.avatar = avatarMap[m.nickname];
                            // Re-serialize to string as client expects string content
                            finalContent = JSON.stringify(parsed);
                        }
                    } catch (e) { }

                    return {
                        id: m.id,
                        room_id: m.room_id,
                        username: m.nickname,
                        content: finalContent,
                        timestamp: m.created_at
                    };
                });

                socket.emit('load_messages', normalized);
            }
        }
    });

    socket.on('leave_room', (rid) => socket.leave(rid));

    socket.on('delete_message', async ({ roomId, messageId }) => {
        const { error } = await supabase.from('messages').delete().eq('id', messageId);
        if (!error) io.to(roomId).emit('message_deleted', messageId);
    });

    // --- Push ---
    socket.on('update_subscription', (sub) => {
        if (socket.username) subscriptions[socket.username] = sub;
    });

    function sendPush(sender, contentRaw, roomId) {
        let text = "New Message";
        try {
            const p = JSON.parse(contentRaw);
            if (p.text) text = p.text;
        } catch (e) { text = contentRaw; }

        const payload = JSON.stringify({ title: sender, body: text, url: `/?room=${roomId}` });

        Object.keys(subscriptions).forEach(u => {
            if (u !== sender) webpush.sendNotification(subscriptions[u], payload).catch(e => { });
        });
    }
});

async function sendRoomList(socket) {
    const { data } = await supabase.from('rooms').select('*');
    if (data) socket.emit('room_list', data);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));
