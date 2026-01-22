const socket = io();

// State
let currentUser = null;
let currentRoomId = null;
const emojis = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "😘", "🥰", "😗", "😙", "😚", "🙂", "🤗", "🤩", "🤔", "🤨", "😐", "😑", "😶", "🙄", "😏", "😣", "😥", "😮", "🤐", "😯", "😪", "😫", "😴", "😌", "😛", "😜", "😝", "🤤", "😒", "😓", "😔", "😕", "🙃", "🤑", "😲", "☹️", "🙁", "😖", "😞", "😟", "😤", "😢", "😭", "😦", "😧", "😨", "😩", "🤯", "😬", "😰", "😱", "🥵", "🥶", "😳", "🤪", "😵", "😡", "😠", "🤬", "😷", "🤒", "🤕", "🤢", "🤮", "🤧", "😇", "🥳", "🥺", "🤠", "🤡", "🤥", "🤫", "🤭", "🧐", "🤓", "😈", "👿", "👹", "👺", "💀", "👻", "👽", "🤖", "💩", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾"];
let settings = {
    timeEnabled: false,
    timeValue: ''
};

// --- Auto-Login Logic ---
const savedNick = localStorage.getItem('savedNickname');
if (savedNick) document.getElementById('username-input').value = savedNick;

document.getElementById('login-btn').addEventListener('click', () => {
    const u = document.getElementById('username-input').value.trim();
    const p = document.getElementById('password-input').value.trim();
    if (u && p) socket.emit('login', { username: u, password: p });
});

socket.on('login_fail', alert);
socket.on('login_success', ({ username, avatar }) => {
    currentUser = username;
    localStorage.setItem('savedNickname', username);

    // Sync Server Avatar to Local Storage (Persistence Fix)
    if (avatar) {
        let sp = JSON.parse(localStorage.getItem('savedProfiles') || '{}');
        sp[username] = avatar;
        localStorage.setItem('savedProfiles', JSON.stringify(sp));
    }

    // Init Features
    renderSavedProfiles();
    restoreSubscription();
    requestWakeLock();

    // Nav
    showScreen('room-list-screen');
});

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// --- Menu Navigation ---
const menuModal = document.getElementById('main-menu-modal');
const registryModal = document.getElementById('registry-modal');
const settingsModal = document.getElementById('settings-modal');

const closeAll = () => {
    menuModal.classList.remove('visible');
    registryModal.classList.remove('visible');
    settingsModal.classList.remove('visible');
};

// Bind Open Buttons
['main-menu-btn', 'room-menu-btn'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
        closeAll();
        menuModal.classList.add('visible');
    });
});
// Bind Close Buttons
document.querySelectorAll('.close-modal-btn').forEach(b => b.onclick = closeAll);
document.querySelectorAll('.back-to-menu-btn').forEach(b => {
    b.onclick = () => { closeAll(); menuModal.classList.add('visible'); };
});

// Main Menu Choices
document.getElementById('open-registry-btn').onclick = () => {
    closeAll();
    registryModal.classList.add('visible');
    renderSavedProfiles();
};
document.getElementById('open-settings-btn').onclick = () => {
    closeAll();
    settingsModal.classList.add('visible');
};

// --- Registry Logic ---
document.getElementById('reg-submit-btn').onclick = async () => {
    const nick = document.getElementById('reg-nickname').value.trim();
    const file = document.getElementById('reg-image').files[0];
    if (!nick || !file) return alert('Nickname & Image required');
    if (file.size > 5 * 1024 * 1024) return alert('Max 5MB');

    const formData = new FormData();
    formData.append('nickname', nick);
    formData.append('image', file);

    try {
        const res = await fetch('/api/upload-avatar', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            // Save to Local Storage so it appears in the list
            let sp = JSON.parse(localStorage.getItem('savedProfiles') || '{}');
            sp[nick] = data.url;
            localStorage.setItem('savedProfiles', JSON.stringify(sp));

            // Update UI
            renderSavedProfiles();

            alert(`Registered '${nick}' with Cloudinary!`);
            document.getElementById('reg-nickname').value = '';
            document.getElementById('reg-image').value = '';
        } else {
            alert('Upload failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        console.error(e);
        alert('Error uploading image');
    }
};

function renderSavedProfiles() {
    const div = document.getElementById('saved-profiles-list');
    div.innerHTML = '';
    const sp = JSON.parse(localStorage.getItem('savedProfiles') || '{}');
    const keys = Object.keys(sp);

    if (keys.length === 0) {
        div.innerHTML = '<span style="grid-column:span 4; text-align:center; font-size:12px; color:#666;">No characters saved</span>';
        return;
    }

    keys.forEach(k => {
        const d = document.createElement('div');
        d.className = 'profile-cell';
        d.innerHTML = `<div class="thumb" style="background-image:url(${sp[k]})"></div><span class="nick">${k}</span>`;
        div.appendChild(d);
    });
}

// --- Settings Logic ---
const tToggle = document.getElementById('time-toggle');
const tPicker = document.getElementById('time-picker');
tToggle.onchange = (e) => {
    settings.timeEnabled = e.target.checked;
    tPicker.disabled = !e.target.checked;
};
tPicker.onchange = (e) => settings.timeValue = e.target.value;

document.getElementById('logout-btn').onclick = () => location.reload();
document.getElementById('reset-local-btn').onclick = () => {
    if (confirm('Clear all local data?')) {
        localStorage.clear();
        location.reload();
    }
};

// --- Rooms ---
socket.on('room_list', (list) => {
    const div = document.getElementById('rooms-list');
    div.innerHTML = '';
    list.forEach(r => {
        const c = document.createElement('div');
        c.className = 'room-card';
        c.textContent = r.title;
        c.onclick = () => socket.emit('join_room', r.id);
        div.appendChild(c);
    });
});
document.getElementById('create-room-btn').onclick = () => {
    const t = prompt('Room Title:');
    if (t) socket.emit('create_room', t);
};
socket.on('room_created', (r) => {
    const div = document.getElementById('rooms-list');
    if (div) {
        const c = document.createElement('div');
        c.className = 'room-card';
        c.textContent = r.title;
        c.onclick = () => socket.emit('join_room', r.id);
        div.appendChild(c);
    }
});

// ⭐ Scope-Safe Profile Update Listener
socket.on('profile_updated', ({ nickname, image }) => {
    // Only update elements that specifically match this nickname
    const targets = document.querySelectorAll(`.avatar[data-sender="${nickname}"]`);
    targets.forEach(el => {
        el.style.backgroundImage = `url(${image})`;
    });
    // Also update registry list if visible
    renderSavedProfiles();
});

// --- Chat ---
socket.on('joined_room', (r) => {
    currentRoomId = r.id;
    document.getElementById('room-title').textContent = r.title;
    document.getElementById('messages-container').innerHTML = '';
    showScreen('chat-room-screen');
});
document.getElementById('back-btn').onclick = () => {
    socket.emit('leave_room', currentRoomId);
    showScreen('room-list-screen');
};

// --- Messaging ---
// --- Messaging ---
// Fix: Use addEventListener for better reliability
const sendBtn = document.getElementById('send-btn');
const msgInput = document.getElementById('message-input');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPopup = document.getElementById('emoji-popup');

if (sendBtn) sendBtn.addEventListener('click', sendMsg);

if (msgInput) {
    msgInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMsg();
    });
}

// Emoji Button Logic
if (emojiBtn && emojiPopup) {
    // 1. Populate if empty
    if (emojiPopup.innerHTML === '') {
        emojis.forEach(e => {
            const span = document.createElement('span');
            span.textContent = e;
            span.className = 'emoji-item';
            span.onclick = () => {
                msgInput.value += e;
                msgInput.focus();
                emojiPopup.classList.add('hidden');
            };
            emojiPopup.appendChild(span);
        });
    }

    // 2. Toggle Visibility
    emojiBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent document click from closing immediately
        emojiPopup.classList.toggle('hidden');
    });

    // 3. Close on outside click
    document.addEventListener('click', (e) => {
        if (!emojiPopup.contains(e.target) && e.target !== emojiBtn) {
            emojiPopup.classList.add('hidden');
        }
    });
}


function sendMsg() {
    const txt = document.getElementById('message-input').value.trim();
    if (!txt || !currentRoomId) return;

    // We send MINIMAL meta, Server will inject authoritative Avatar
    // BUT we also send it from Client as a BACKUP in case Server memory is empty.
    const meta = {
        nickname: currentUser,
        avatar: userAvatar || null, // ✅ BACKUP: Send what we have
        timestampOverride: settings.timeEnabled ? settings.timeValue : null
    };

    const payload = JSON.stringify({ text: txt, meta });
    socket.emit('send_message', { roomId: currentRoomId, content: payload });
    document.getElementById('message-input').value = '';
}

socket.on('load_messages', msgs => msgs.forEach(renderMsg));
socket.on('new_message', msg => {
    if (msg.room_id === currentRoomId) renderMsg(msg);
});

function renderMsg(msg) {
    if (!msg) return;

    // 1. Safe JSON Parse
    let text = msg.content || '';
    let meta = {};
    try {
        // Only parse if it looks like JSON
        if (typeof text === 'string' && text.startsWith('{')) {
            const p = JSON.parse(text);
            if (p.text) {
                text = p.text;
                meta = p.meta || {};
            }
        }
    } catch (e) {
        // Fallback: Treat content as plain text if parse fails
        // console.warn('JSON Parse Warning:', e);
    }

    // 2. Normalize Keys (Client Safety)
    // Server now sends 'username', but we fallback to 'nickname' just in case.
    const senderName = msg.username || msg.nickname || 'Unknown';
    const isMe = (senderName === currentUser);

    const div = document.createElement('div');
    div.className = `msg-wrapper ${isMe ? 'my' : 'other'}`;
    div.id = `msg-${msg.id || Date.now()}`;

    // 3. HTML Construction with Optional Chaining
    let html = '';
    if (!isMe) {
        // Avatar: Server Injection Priority (Top Level > Meta Content)
        const finalAvatar = msg.avatar || meta?.avatar;
        const bg = finalAvatar ? `url(${finalAvatar})` : 'none';

        // ⭐ Add data-sender for targeted updates
        const targetNick = meta?.nickname || senderName;
        html += `<div class="avatar" data-sender="${targetNick}" style="background-image:${bg}"></div>`;
        html += `<div class="other-content"><span class="sender-name">${targetNick}</span>`;
    }

    html += `<div class="bubble-row"><div class="bubble">${text}</div>`;

    // 4. Timestamp Safety
    let ts = '';
    if (meta?.timestampOverride) {
        ts = meta.timestampOverride;
    } else {
        try {
            const rawTime = msg.timestamp || msg.created_at || new Date().toISOString();
            const d = new Date(rawTime);
            ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch (e) {
            ts = '00:00';
        }
    }

    html += `<span class="time-stamp">${ts}</span></div>`; // End row
    if (!isMe) html += `</div>`; // End other-content

    div.innerHTML = html;
    div.onclick = () => showDelete(msg.id);

    const container = document.getElementById('messages-container');
    if (container) {
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
}

// --- Delete ---
const delPopup = document.getElementById('delete-popup');
let delTarget = null;
function showDelete(id) { delTarget = id; delPopup.classList.remove('hidden'); }
document.getElementById('confirm-delete').onclick = () => {
    if (delTarget) socket.emit('delete_message', { roomId: currentRoomId, messageId: delTarget });
    delPopup.classList.add('hidden');
};
document.onclick = (e) => {
    if (!delPopup.contains(e.target) && !e.target.closest('.msg-wrapper')) delPopup.classList.add('hidden');
};
socket.on('message_deleted', id => {
    const el = document.getElementById(`msg-${id}`);
    if (el) el.remove();
});

// --- Extras ---
async function restoreSubscription() {
    // Service worker logic
}
async function requestWakeLock() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { }
}
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}
