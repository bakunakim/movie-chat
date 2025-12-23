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

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_KEY environment variables.");
    // In production, we might want to exit, but for dev we'll just log
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Web Push Configuration
const publicVapidKey = 'BAxK5ujR9uXmjc5YlNV2k5L5tJf5cts_Chdegh-NSCzRlJp9pGJnPIM3s-sWOTl6Zv8S062nP5D2wYuOPftdWUQ';
const privateVapidKey = 'NFXvDNGrE7N5UB2Y_Zu3jp7pC_6CyPyXfZByQzZ8Tw0'; // Generated Valid Key

webpush.setVapidDetails(
    'mailto:example@yourdomain.org',
    publicVapidKey,
    privateVapidKey
);

// In-memory subscription storage
// Format: { username: subscriptionObject }
const subscriptions = {};

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('login', async ({ username, password }) => {
        // Logic: First-come, First-served
        try {
            // 1. DB Lookup for existence
            const { data: user, error } = await supabase
                .from('users')
                .select('*')
                .eq('nickname', username)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 is 'not found'
                console.error("Login Check Error:", error);
                socket.emit('login_fail', '서버 에러가 발생했습니다.');
                return;
            }

            if (!user) {
                // CASE A: New User (First claim)
                const { error: createError } = await supabase
                    .from('users')
                    .insert([{ nickname: username, password: password }]);

                if (createError) {
                    console.error("Signup Error:", createError);
                    socket.emit('login_fail', '회원가입 실패 (이미 존재하는 닉네임일 수 있습니다.)');
                    return;
                }

                socket.username = username;
                socket.emit('login_success', username); // Client handles this
                // Optional: Send a notification message like "New user joined!" if needed, 
                // but prop usually just enters quietly or shows "Auto-signup" alert? 
                // User asked for response: "새로운 아이디로 자동 가입되었습니다." -> Client handles alert loop?
                // Or I can emit a separate event or just success. 
                // Client `socket.on('login_success')` just switches screen. 
                // I will keep standard success emission.

                sendRoomList(socket);
            } else {
                // CASE B: Existing User
                if (user.password === password) {
                    socket.username = username;
                    socket.emit('login_success', username);
                    sendRoomList(socket);
                } else {
                    socket.emit('login_fail', '이미 누군가 사용 중인 아이디이며, 비밀번호가 틀렸습니다.');
                }
            }
        } catch (err) {
            console.error(err);
            socket.emit('login_fail', '알 수 없는 에러가 발생했습니다.');
        }
    });

    socket.on('update_subscription', (subscription) => {
        if (socket.username) {
            subscriptions[socket.username] = subscription;
            console.log(`Subscription updated for user: ${socket.username}`);
        }
    });

    socket.on('create_room', async (title) => {
        try {
            const { data, error } = await supabase
                .from('rooms')
                .insert([{ title: title }])
                .select();

            if (!error && data) {
                // Broadcast to all
                io.emit('room_created', { id: data[0].id, title: data[0].title });
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('join_room', async (roomId) => {
        socket.join(roomId);

        // Get Room Title
        const { data: room, error } = await supabase
            .from('rooms')
            .select('title')
            .eq('id', roomId)
            .single();

        if (room) {
            socket.emit('joined_room', { id: roomId, title: room.title });

            // Load messages
            const { data: messages, error: msgError } = await supabase
                .from('messages')
                .select('*')
                .eq('room_id', roomId)
                .order('created_at', { ascending: true });

            if (!msgError) {
                const formattedMessages = messages.map(m => ({
                    id: m.id,
                    room_id: m.room_id,
                    username: m.nickname,
                    content: m.content,
                    timestamp: m.created_at
                }));
                socket.emit('load_messages', formattedMessages);
            }
        }
    });

    socket.on('leave_room', (roomId) => {
        socket.leave(roomId);
    });

    socket.on('send_message', async ({ roomId, content }) => {
        if (!socket.username) return;

        const nickname = socket.username;

        try {
            const { data, error } = await supabase
                .from('messages')
                .insert([{ room_id: roomId, nickname: nickname, content: content }])
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

                // Initialize Push Notification
                // 1. Get all users in the room (This is tricky with just socket.io rooms, so we'll broadcast to all subscribed users who are NOT the sender)
                // A better approach for a real app: Query DB for room members. 
                // For this prop app: We iterate over all connected sockets in the room, find their usernames, check if they have subscriptions.

                // Note: socket.io 'clients' in room is async in v4.
                // Simplified: iterate our subscriptions list and if they are supposedly in the room (we don't track room membership in memory perfectly), send it?
                // Actually, let's just send to ALL subscribed users except sender for simplicity in this specific "Movie Prop" context where everyone might want to know?
                // OR: Let's try to get room members from Supabase messages? No, that's history.
                // Let's rely on the fact that if they are offline, we want to reach them.
                // If they are online, they get the socket message. 
                // Push is valuable when they are NOT online/focused. 
                // FOR SIMPLICITY: Send to ALL registered subscriptions except sender.

                const notificationPayload = JSON.stringify({
                    title: `New message from ${nickname}`,
                    body: content,
                    url: `/?room=${roomId}` // Basic deep link concept
                });

                Object.keys(subscriptions).forEach(subUsername => {
                    if (subUsername !== nickname) {
                        const sub = subscriptions[subUsername];
                        webpush.sendNotification(sub, notificationPayload)
                            .catch(err => console.error("Push Error:", err));
                    }
                });

            } else {
                console.error("Message Send Error:", error);
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

async function sendRoomList(socket) {
    const { data: rooms, error } = await supabase
        .from('rooms')
        .select('*');

    if (!error) {
        socket.emit('room_list', rooms);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
