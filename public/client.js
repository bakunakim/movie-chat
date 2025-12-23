const socket = io();

// State
let currentUser = null;
let currentRoomId = null;

// Nano Banana SVGs
const BANANA_SVGS = {
    '::banana-happy::': `<svg viewBox="0 0 100 100" class="emoji-img"><path d="M20,80 Q50,10 80,80" fill="#FFE135" stroke="black" stroke-width="2"/><circle cx="35" cy="45" r="5" fill="black"/><circle cx="65" cy="45" r="5" fill="black"/><path d="M35,60 Q50,75 65,60" fill="none" stroke="black" stroke-width="3"/></svg>`,
    '::banana-angry::': `<svg viewBox="0 0 100 100" class="emoji-img"><path d="M20,80 Q50,10 80,80" fill="#FF6B6B" stroke="black" stroke-width="2"/><path d="M30,40 L45,50" stroke="black" stroke-width="3"/><path d="M70,40 L55,50" stroke="black" stroke-width="3"/><circle cx="35" cy="55" r="3" fill="black"/><circle cx="65" cy="55" r="3" fill="black"/><path d="M40,75 Q50,65 60,75" fill="none" stroke="black" stroke-width="3"/></svg>`,
    '::banana-love::': `<svg viewBox="0 0 100 100" class="emoji-img"><path d="M20,80 Q50,10 80,80" fill="#FFE135" stroke="black" stroke-width="2"/><path d="M30,45 Q35,35 40,45 Q45,35 50,45 L40,60 Z" fill="#FF4081"/><path d="M60,45 Q65,35 70,45 Q75,35 80,45 L70,60 Z" fill="#FF4081"/><path d="M40,70 Q50,80 60,70" fill="none" stroke="black" stroke-width="3"/></svg>`,
    '::banana-sad::': `<svg viewBox="0 0 100 100" class="emoji-img"><path d="M20,80 Q50,10 80,80" fill="#81D4FA" stroke="black" stroke-width="2"/><circle cx="35" cy="50" r="4" fill="black"/><circle cx="65" cy="50" r="4" fill="black"/><path d="M40,75 Q50,65 60,75" fill="none" stroke="black" stroke-width="3"/><circle cx="25" cy="60" r="3" fill="#29B6F6"/><circle cx="75" cy="60" r="3" fill="#29B6F6"/></svg>`,
    '::banana-cool::': `<svg viewBox="0 0 100 100" class="emoji-img"><path d="M20,80 Q50,10 80,80" fill="#FFE135" stroke="black" stroke-width="2"/><path d="M25,45 L75,45 L70,60 L30,60 Z" fill="black"/><path d="M25,45 Q50,40 75,45" fill="none" stroke="black" stroke-width="2"/><path d="M40,75 Q50,80 60,75" fill="none" stroke="black" stroke-width="3"/></svg>`
};

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const roomListScreen = document.getElementById('room-list-screen');
const chatRoomScreen = document.getElementById('chat-room-screen');

const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');

const roomsContainer = document.getElementById('rooms-container');
const createRoomBtn = document.getElementById('create-room-btn');

const chatTitle = document.getElementById('chat-title');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const backBtn = document.getElementById('back-btn');

const emojiBtn = document.getElementById('emoji-btn');
const emojiPopup = document.getElementById('emoji-popup');

// Init Emoji Popup
Object.keys(BANANA_SVGS).forEach(key => {
    const div = document.createElement('div');
    div.className = 'emoji-option';
    div.innerHTML = BANANA_SVGS[key]; // Render SVG preview
    div.addEventListener('click', () => {
        if (currentRoomId) {
            socket.emit('send_message', { roomId: currentRoomId, content: key });
            emojiPopup.classList.add('hidden');
        }
    });
    emojiPopup.appendChild(div);
});

emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPopup.classList.toggle('hidden');
});

// Close popup on click outside
document.addEventListener('click', (e) => {
    if (!emojiPopup.contains(e.target) && e.target !== emojiBtn) {
        emojiPopup.classList.add('hidden');
    }
});

// Navigation
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// Login
loginBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    if (username && password) {
        socket.emit('login', { username, password });
    }
});

socket.on('login_success', (username) => {
    currentUser = username;
    showScreen('room-list-screen');

    // Register Service Worker and Subscribe to Push
    // Moved to manual button click for iOS support

    // ⭐ [Server Amnesia Fix] Restore existing subscription if available
    restoreSubscription();

    // ⭐ [Wake Lock] Keep screen on
    requestWakeLock();
});

// ⭐ [Server Amnesia Fix]
async function restoreSubscription() {
    if ('serviceWorker' in navigator) {
        try {
            const register = await navigator.serviceWorker.ready;
            const subscription = await register.pushManager.getSubscription();
            if (subscription) {
                console.log("Restoring existing subscription to server...");
                socket.emit('update_subscription', subscription);
            }
        } catch (err) {
            console.error("Error restoring subscription:", err);
        }
    }
}

// ⭐ [Wake Lock]
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            await navigator.wakeLock.request('screen');
            console.log('Wake Lock active');
        }
    } catch (err) {
        console.log('Wake Lock Error:', err);
    }
}

// Notification Button Logic
const enableNotiBtn = document.getElementById('enable-noti-btn');

enableNotiBtn.addEventListener('click', () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert('This browser does not support notifications.');
        return;
    }

    Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
            registerServiceWorker().then(() => {
                alert('Notifications enabled!');
                enableNotiBtn.style.display = 'none'; // Hide button after success
            });
        } else {
            alert('Notification permission denied.');
        }
    });
});

function registerServiceWorker() {
    return navigator.serviceWorker.register('/sw.js')
        .then(function (swReg) {
            console.log('Service Worker Registered', swReg);

            const applicationServerKey = urlBase64ToUint8Array('BAxK5ujR9uXmjc5YlNV2k5L5tJf5cts_Chdegh-NSCzRlJp9pGJnPIM3s-sWOTl6Zv8S062nP5D2wYuOPftdWUQ');
            return swReg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });
        })
        .then(function (subscription) {
            console.log('User is subscribed:', subscription);
            socket.emit('update_subscription', subscription);
        })
        .catch(function (err) {
            console.log('Failed to subscribe the user: ', err);
        });
}

// Helper function for VAPID key conversion
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}


socket.on('login_fail', (msg) => {
    alert(msg);
});

// Rooms
socket.on('room_list', (rooms) => {
    roomsContainer.innerHTML = '';
    rooms.forEach(room => {
        const div = document.createElement('div');
        div.className = 'room-item';
        div.textContent = room.title;
        div.addEventListener('click', () => {
            socket.emit('join_room', room.id);
        });
        roomsContainer.appendChild(div);
    });
});

createRoomBtn.addEventListener('click', () => {
    const title = prompt('Enter Room Name:');
    if (title) {
        socket.emit('create_room', title);
    }
});

socket.on('room_created', (room) => {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.textContent = room.title;
    div.addEventListener('click', () => {
        socket.emit('join_room', room.id);
    });
    roomsContainer.appendChild(div);
});

// Chat
socket.on('joined_room', (room) => {
    currentRoomId = room.id;
    chatTitle.textContent = room.title;
    messagesContainer.innerHTML = '';
    showScreen('chat-room-screen');
});

socket.on('load_messages', (messages) => {
    messages.forEach(addMessage);
});

socket.on('new_message', (msg) => {
    if (msg.room_id === currentRoomId) {
        addMessage(msg);
    }
});

function addMessage(msg) {
    const isEmoji = BANANA_SVGS.hasOwnProperty(msg.content);

    // If emoji, add special class to remove bubble style if desired.
    // We already have .my-msg / .other-msg for positioning.
    // If it's a sticker, we might want to keep positioning but remove background.

    const div = document.createElement('div');
    div.className = `message ${msg.username === currentUser ? 'my-msg' : 'other-msg'} ${isEmoji ? 'emoji-msg' : ''}`;

    let html = '';
    if (msg.username !== currentUser) {
        html += `<span class="msg-sender">${msg.username}</span>`;
    }

    if (isEmoji) {
        html += BANANA_SVGS[msg.content];
    } else {
        html += `<span class="msg-content">${msg.content}</span>`;
    }

    div.innerHTML = html;
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const content = messageInput.value.trim();
    if (content && currentRoomId) {
        socket.emit('send_message', { roomId: currentRoomId, content });
        messageInput.value = '';
    }
}

backBtn.addEventListener('click', () => {
    socket.emit('leave_room', currentRoomId);
    currentRoomId = null;
    showScreen('room-list-screen');
});
