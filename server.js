require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- Supabase Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Web Push ---
const publicVapidKey = 'BAxK5ujR9uXmjc5YlNV2k5L5tJf5cts_Chdegh-NSCzRlJp9pGJnPIM3s-sWOTl6Zv8S062nP5D2wYuOPftdWUQ';
const privateVapidKey = 'NFXvDNGrE7N5UB2Y_Zu3jp7pC_6CyPyXfZByQzZ8Tw0';

webpush.setVapidDetails('mailto:example@yourdomain.org', publicVapidKey, privateVapidKey);

const subscriptions = {};
const characterProfiles = {}; // { "nickname": "base64..." }

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {

    // --- Login ---
    socket.on('login', async ({ username, password }) => {
        try {
            const { data: user, error } = await supabase.from('users').select('*').eq('nickname', username).single();

            // Auto-signup logic
            let success = false;
            if (!user) {
                const { error: createErr } = await supabase.from('users').insert([{ nickname: username, password }]);
                if (!createErr) success = true;
            } else if (user.password === password) {
                success = true;
            }

            if (success) {
                socket.username = username;
                // Send current avatar from registry if exists
                const avatar = characterProfiles[username] || null;
                socket.emit('login_success', { username, avatar });
                sendRoomList(socket);
            } else {
                socket.emit('login_fail', 'Login Failed');
            }
        } catch (e) {
            console.error(e);
            socket.emit('login_fail', 'Server Error');
        }
    });

    // --- Registry ---
    socket.on('register_character', ({ nickname, image }) => {
        characterProfiles[nickname] = image;
        // Broadcast update to all (optional, but good for real-time)
    });

    socket.on('restore_profiles', (profiles) => {
        if (profiles && typeof profiles === 'object') {
            Object.assign(characterProfiles, profiles);
            console.log(`[Server] Restored ${Object.keys(profiles).length} profiles.`);
        }
    });

    // --- Messaging (CRITICAL FIX) ---
    socket.on('send_message', async ({ roomId, content }) => {
        if (!socket.username) return;

        // 1. Force Server-Side Avatar Lookup
        let finalContent = content;
        try {
            // Content is expected to be JSON string from client
            const parsed = JSON.parse(content);

            // Check Registry
            const serverAvatar = characterProfiles[socket.username];

            // Inject/Override Avatar
            parsed.meta = parsed.meta || {};
            parsed.meta.nickname = socket.username;
            if (serverAvatar) {
                parsed.meta.avatar = serverAvatar; // Source of Truth
            }

            finalContent = JSON.stringify(parsed);

        } catch (e) {
            // If content wasn't JSON, we leave it (legacy support), 
            // but for this app we strictly use JSON now.
        }

        // 2. Save to DB
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
                content: newMsg.content, // Includes the injected avatar
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
        const { data: room } = await supabase.from('rooms').select('title').eq('id', rid).single();
        if (room) {
            socket.emit('joined_room', { id: rid, title: room.title });
            const { data: msgs } = await supabase.from('messages').select('*').eq('room_id', rid).order('created_at');
            if (msgs) socket.emit('load_messages', msgs);
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
