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

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_KEY environment variables.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- Web Push Configuration ---
const publicVapidKey = 'BAxK5ujR9uXmjc5YlNV2k5L5tJf5cts_Chdegh-NSCzRlJp9pGJnPIM3s-sWOTl6Zv8S062nP5D2wYuOPftdWUQ';
const privateVapidKey = 'NFXvDNGrE7N5UB2Y_Zu3jp7pC_6CyPyXfZByQzZ8Tw0';

webpush.setVapidDetails(
    'mailto:example@yourdomain.org',
    publicVapidKey,
    privateVapidKey
);

// --- In-Memory Stores ---
const subscriptions = {}; // { username: subscriptionObject }

// ⭐ Global Character Registry (Global Profile Registry)
// Format: { "nickname": "base64_image_string" }
const characterProfiles = {};

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('New client connected');

    // --- Login ---
    socket.on('login', async ({ username, password }) => {
        try {
            // 1. Check DB
            const { data: user, error } = await supabase
                .from('users')
                .select('*')
                .eq('nickname', username)
                .single();

            if (error && error.code !== 'PGRST116') {
                socket.emit('login_fail', '서버 에러가 발생했습니다.');
                return;
            }

            let loginSuccess = false;

            if (!user) {
                // New User (Auto-Signup)
                const { error: createError } = await supabase
                    .from('users')
                    .insert([{ nickname: username, password: password }]);

                if (!createError) loginSuccess = true;
            } else {
                // Existing User
                if (user.password === password) loginSuccess = true;
            }

            if (loginSuccess) {
                socket.username = username;

                // ⭐ Check Registry for Auto-Profile
                let assignedAvatar = null;
                if (characterProfiles[username]) {
                    assignedAvatar = characterProfiles[username];
                }

                socket.emit('login_success', { username, avatar: assignedAvatar });
                sendRoomList(socket);
            } else {
                socket.emit('login_fail', '로그인 실패: 비밀번호가 틀렸거나 오류가 발생했습니다.');
            }

        } catch (err) {
            console.error(err);
            socket.emit('login_fail', '알 수 없는 서버 에러.');
        }
    });

    // --- Registry Management ---
    socket.on('register_character', ({ nickname, image }) => {
        // Admin feature mostly, but open to all for this prop
        characterProfiles[nickname] = image;
        console.log(`Character Registered: ${nickname}`);
    });

    // ⭐ Smart Restore (Client -> Server)
    socket.on('restore_profiles', (profiles) => {
        if (profiles && typeof profiles === 'object') {
            Object.assign(characterProfiles, profiles);
            console.log(`Restored ${Object.keys(profiles).length} profiles from client.`);
        }
    });

    socket.on('update_subscription', (subscription) => {
        if (socket.username) {
            subscriptions[socket.username] = subscription;
        }
    });

    // --- Rooms ---
    socket.on('create_room', async (title) => {
        const { data, error } = await supabase.from('rooms').insert([{ title }]).select();
        if (!error && data) {
            io.emit('room_created', { id: data[0].id, title: data[0].title });
        }
    });

    socket.on('join_room', async (roomId) => {
        socket.join(roomId);
        const { data: room } = await supabase.from('rooms').select('title').eq('id', roomId).single();
        if (room) {
            socket.emit('joined_room', { id: roomId, title: room.title });

            const { data: messages } = await supabase
                .from('messages')
                .select('*')
                .eq('room_id', roomId)
                .order('created_at', { ascending: true });

            if (messages) {
                // Map to cleaner format
                const formatted = messages.map(m => ({
                    id: m.id,
                    room_id: m.room_id,
                    username: m.nickname,
                    content: m.content,
                    timestamp: m.created_at
                }));
                socket.emit('load_messages', formatted);
            }
        }
    });

    socket.on('leave_room', (roomId) => {
        socket.leave(roomId);
    });

    // --- Messaging ---
    socket.on('send_message', async ({ roomId, content }) => {
        if (!socket.username) return;

        try {
            const { data, error } = await supabase
                .from('messages')
                .insert([{ room_id: roomId, nickname: socket.username, content }])
                .select();

            if (!error && data) {
                const newMsg = data[0];
                const msgPayload = {
                    id: newMsg.id,
                    room_id: newMsg.room_id,
                    username: newMsg.nickname,
                    content: newMsg.content,
                    timestamp: newMsg.created_at
                };
                io.to(roomId).emit('new_message', msgPayload);

                // Push Notification
                let bodyText = content;
                try {
                    const parsed = JSON.parse(content);
                    if (parsed.text) bodyText = parsed.text;
                } catch (e) { }

                const notif = JSON.stringify({
                    title: socket.username,
                    body: bodyText,
                    url: `/?room=${roomId}`
                });

                Object.keys(subscriptions).forEach(u => {
                    if (u !== socket.username) {
                        webpush.sendNotification(subscriptions[u], notif).catch(e => console.error(e));
                    }
                });
            }
        } catch (e) {
            console.error(e);
        }
    });

    // --- God's Hand (Delete) ---
    socket.on('delete_message', async ({ roomId, messageId }) => {
        const { error } = await supabase.from('messages').delete().eq('id', messageId);
        if (!error) {
            io.to(roomId).emit('message_deleted', messageId);
        }
    });

    socket.on('disconnect', () => { });
});

async function sendRoomList(socket) {
    const { data: rooms } = await supabase.from('rooms').select('*');
    if (rooms) socket.emit('room_list', rooms);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
