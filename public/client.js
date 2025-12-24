const socket = io();

// --- State ---
let currentUser = null;
let currentRoomId = null;
let userAvatar = null; // Assigned from server

// Settings State
let customTimeEnabled = false;
let customTimeValue = '';

// --- DOM ---
const screens = {
    login: document.getElementById('login-screen'),
    roomList: document.getElementById('room-list-screen'),
    chat: document.getElementById('chat-room-screen')
};

// --- Init ---
// Auto-fill nickname
const savedNickname = localStorage.getItem('savedNickname');
if (savedNickname) {
    document.getElementById('username-input').value = savedNickname;
}

// --- Login & Auth ---
document.getElementById('login-btn').addEventListener('click', login);

function login() {
    const user = document.getElementById('username-input').value.trim();
    const pass = document.getElementById('password-input').value.trim();
    if (user && pass) {
        socket.emit('login', { username: user, password: pass });
    }
}

socket.on('login_success', (data) => {
    // Data: { username, avatar }
    currentUser = data.username;
    userAvatar = data.avatar; // Base64 or null

    // Save nickname
    localStorage.setItem('savedNickname', currentUser);

    showScreen('roomList');
    restoreSubscription();
    requestWakeLock();
});

socket.on('login_fail', (msg) => alert(msg));

// --- Navigation ---
function showScreen(name) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[name].classList.add('active');
}

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('savedNickname'); // Optional clean up
    location.reload();
});

// --- Settings Menu ---
const modal = document.getElementById('settings-modal');
const menuBtn = document.getElementById('menu-btn'); // In chat
const globalRegBtn = document.getElementById('global-reg-btn'); // In room list
const closeSettings = document.getElementById('close-settings');

[menuBtn, globalRegBtn].forEach(btn => {
    if (btn) btn.addEventListener('click', () => {
        modal.classList.add('visible');
    });
});

closeSettings.addEventListener('click', () => modal.classList.remove('visible'));

// 1. Time Machine
const timeToggle = document.getElementById('time-toggle');
const timePicker = document.getElementById('time-picker');

timeToggle.addEventListener('change', (e) => {
    customTimeEnabled = e.target.checked;
    timePicker.disabled = !customTimeEnabled;
});
timePicker.addEventListener('change', (e) => {
    customTimeValue = e.target.value;
});

// 2. Character Registry (Admin)
const regSubmitBtn = document.getElementById('reg-submit-btn');
const regImageInput = document.getElementById('reg-image');

// ⭐ Smart Auto-Restore
socket.on('connect', () => {
    const saved = localStorage.getItem('savedProfiles');
    if (saved) {
        try {
            const profiles = JSON.parse(saved);
            socket.emit('restore_profiles', profiles);
            console.log('Restoring profiles to server...');
        } catch (e) {
            console.error('Failed to restore profiles', e);
        }
    }
});

regSubmitBtn.addEventListener('click', () => {
    const nick = document.getElementById('reg-nickname').value.trim();
    const file = regImageInput.files[0];

    if (nick && file) {
        if (file.size > 1024 * 1024) {
            alert('Image too large (Max 1MB)');
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target.result;
            socket.emit('register_character', { nickname: nick, image: base64 });

            // ⭐ Save to LocalStorage
            let saved = JSON.parse(localStorage.getItem('savedProfiles') || '{}');
            saved[nick] = base64;
            localStorage.setItem('savedProfiles', JSON.stringify(saved));

            alert(`Character '${nick}' registered & Saved locally!`);
        };
        reader.readAsDataURL(file);
    } else {
        alert('Please enter nickname and select image.');
    }
});


// --- Rooms ---
socket.on('room_list', (rooms) => {
    const container = document.getElementById('rooms-list');
    container.innerHTML = '';
    rooms.forEach(r => {
        const div = document.createElement('div');
        div.className = 'room-card';
        div.innerHTML = `<strong>${r.title}</strong>`;
        div.onclick = () => socket.emit('join_room', r.id);
        container.appendChild(div);
    });
});

document.getElementById('create-room-btn').addEventListener('click', () => {
    const t = prompt('Room Title:');
    if (t) socket.emit('create_room', t);
});

socket.on('room_created', (r) => {
    // Lazy reload or append. 
    // Ideally we re-request or append. For simplicity, just append to list if visible.
    // If not visible, next socket.on('room_list') will handle it.
    // Let's rely on room_list being resent on login, but for live updates:
    const div = document.createElement('div');
    div.className = 'room-card';
    div.innerHTML = `<strong>${r.title}</strong>`;
    div.onclick = () => socket.emit('join_room', r.id);
    document.getElementById('rooms-list').appendChild(div);
});

// --- Chat ---
socket.on('joined_room', (r) => {
    currentRoomId = r.id;
    document.getElementById('room-title').textContent = r.title;
    document.getElementById('messages-container').innerHTML = '';
    showScreen('chat');
});

document.getElementById('back-btn').addEventListener('click', () => {
    socket.emit('leave_room', currentRoomId);
    showScreen('roomList');
});

// --- Messaging ---
const msgInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const msgsDiv = document.getElementById('messages-container');

sendBtn.addEventListener('click', sendMsg);
msgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMsg(); });

function sendMsg() {
    const txt = msgInput.value.trim();
    if (!txt || !currentRoomId) return;

    // Metadata Payload
    const meta = {
        nickname: currentUser,
        avatar: userAvatar,
        timestampOverride: customTimeEnabled ? customTimeValue : null
    };

    const payload = JSON.stringify({
        text: txt,
        meta: meta
    });

    socket.emit('send_message', { roomId: currentRoomId, content: payload });
    msgInput.value = '';
}

socket.on('load_messages', (msgs) => msgs.forEach(renderMessage));
socket.on('new_message', (msg) => {
    if (msg.room_id === currentRoomId) renderMessage(msg);
});

function renderMessage(msg) {
    let text = msg.content;
    let meta = {};

    try {
        const parsed = JSON.parse(msg.content);
        if (parsed.text) {
            text = parsed.text;
            meta = parsed.meta || {};
        }
    } catch (e) { }

    const isMe = (msg.username === currentUser);
    const wrapper = document.createElement('div');
    wrapper.className = `msg-wrapper ${isMe ? 'my' : 'other'}`;
    wrapper.id = `msg-${msg.id}`;

    // Avatar (for Other)
    // Priority: Metadata Avatar -> Server Logic logic?
    // Actually, good design: The message itself carries the snapshot of avatar at that time.
    // So we use meta.avatar if present.
    let avatarUrl = meta.avatar || '';

    let html = '';
    if (!isMe) {
        if (avatarUrl) {
            html += `<div class="avatar" style="background-image:url(${avatarUrl})"></div>`;
        } else {
            html += `<div class="avatar"></div>`;
        }
    }

    html += `<div class="other-content">`;
    if (!isMe) html += `<span class="sender-name">${meta.nickname || msg.username}</span>`;

    // Bubble Row
    html += `<div class="bubble-row">`;
    html += `<div class="bubble">${text}</div>`;

    // Time
    let timeStr = '';
    if (meta.timestampOverride) {
        timeStr = meta.timestampOverride;
    } else {
        const d = new Date(msg.timestamp);
        timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    html += `<span class="time-stamp">${timeStr}</span>`;
    html += `</div>`; // End bubble-row
    html += `</div>`; // End other-content

    wrapper.innerHTML = html;

    // God's Hand Click
    wrapper.addEventListener('click', (e) => showDeletePopup(msg.id));

    msgsDiv.appendChild(wrapper);
    msgsDiv.scrollTop = msgsDiv.scrollHeight;
}

// --- God's Hand (Delete) ---
const delPopup = document.getElementById('delete-popup');
const confirmDelBtn = document.getElementById('confirm-delete');
let targetDelId = null;

function showDeletePopup(id) {
    targetDelId = id;
    delPopup.classList.remove('hidden');
}

confirmDelBtn.addEventListener('click', () => {
    if (targetDelId && currentRoomId) {
        socket.emit('delete_message', { roomId: currentRoomId, messageId: targetDelId });
        delPopup.classList.add('hidden');
    }
});

// Close popup on outside click
document.addEventListener('click', (e) => {
    if (!delPopup.contains(e.target) && !e.target.closest('.msg-wrapper')) {
        delPopup.classList.add('hidden');
    }
});

socket.on('message_deleted', (id) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) el.remove();
});

// --- Extras ---
async function restoreSubscription() {
    if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) socket.emit('update_subscription', sub);
    }
}
async function requestWakeLock() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { }
}
document.getElementById('noti-btn').addEventListener('click', () => {
    Notification.requestPermission().then(p => {
        if (p === 'granted') registerSW();
    });
});
function registerSW() {
    navigator.serviceWorker.register('/sw.js').then(reg => {
        const k = urlBase64ToUint8Array('BAxK5ujR9uXmjc5YlNV2k5L5tJf5cts_Chdegh-NSCzRlJp9pGJnPIM3s-sWOTl6Zv8S062nP5D2wYuOPftdWUQ');
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k });
    }).then(sub => {
        socket.emit('update_subscription', sub);
        alert('Notifications ON');
    });
}
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}
