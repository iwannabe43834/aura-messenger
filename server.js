const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// ДОБАВЛЯЕМ СЕРВЕР ДЛЯ ЗВОНКОВ (WebRTC)
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });

// --- Настройка Telegram Бота (Твой тестовый бот) ---
const tgToken = '8666406149:AAHJA4-jhQTk2GDfvwfJdtWJejGfpwHvUEs';
const tgBot = new TelegramBot(tgToken, { polling: true });

// Хранилище временных токенов для привязки Telegram
const pendingTgBinds = {};

tgBot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Ловим Deep Link: /start bind_12345
    if (text.startsWith('/start ')) {
        const token = text.split(' ')[1];
        
        if (pendingTgBinds[token]) {
            pendingTgBinds[token].chatId = chatId;
            pendingTgBinds[token].bound = true;
            tgBot.sendMessage(chatId, "✅ Telegram успешно привязан к Aura Messenger! Возвращайтесь на сайт, регистрация продолжится автоматически.");
        } else {
            tgBot.sendMessage(chatId, "❌ Ссылка устарела или недействительна. Попробуйте нажать кнопку привязки на сайте еще раз.");
        }
    } else if (text === '/start') {
        tgBot.sendMessage(chatId, "👋 Привет! Для привязки аккаунта используйте специальную кнопку на сайте Aura Messenger.");
    }
});

// --- HTML Шаблон для письма ---
function getEmailTemplate(code) { 
    return ` 
    <div style="font-family: -apple-system, sans-serif; background-color: #f0f2f5; padding: 40px 20px; text-align: center;"> 
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 500px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); margin: 0 auto;"> 
            <tr> <td style="background-color: #2AABEE; padding: 25px; text-align: center;"> <h1 style="margin: 0; font-size: 26px; color: #ffffff;">Aura Messenger</h1> </td> </tr> 
            <tr> <td style="padding: 40px 30px; text-align: center; color: #333333;"> 
                <p style="font-size: 18px; margin: 0 0 20px 0;">Здравствуйте!</p> 
                <p style="font-size: 15px; margin: 0 0 30px 0;">Ваш код для входа в Aura Messenger:</p> 
                <div style="display: inline-block; background-color: #f4f8fb; border: 1px solid #e1eef7; border-radius: 10px; padding: 15px 30px; margin-bottom: 30px;"> 
                    <span style="font-size: 36px; font-weight: bold; color: #2AABEE; letter-spacing: 8px;">${code}</span> 
                </div> 
            </td> </tr> 
        </table> 
    </div> `; 
}

const verificationCodes = {};

// --- Настройки сервера ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(session({
    secret: 'aura-secret-key-2026-pro',
    resave: true,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false }
}));

const USERS_FILE = path.join(__dirname, 'users.json');
const GROUPS_FILE = path.join(__dirname, 'groups.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// --- Инициализация файлов и БД ---
function initFiles() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}));
    if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, JSON.stringify({}));
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
}

function readData(file) {
    try { 
        return JSON.parse(fs.readFileSync(file, 'utf8')); 
    } catch (e) { 
        return {}; 
    }
}

function writeData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let db;
async function initDB() {
    initFiles();
    db = await open({
        filename: 'aura_database.db',
        driver: sqlite3.Database
    });
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            fromUser TEXT,
            toUser TEXT,
            text TEXT,
            mediaType TEXT,
            mediaData TEXT,
            mediaName TEXT,
            replyData TEXT,
            time TEXT,
            isRead INTEGER DEFAULT 0,
            isEdited INTEGER DEFAULT 0,
            isPinned INTEGER DEFAULT 0,
            reactions TEXT,
            deletedFor TEXT
        )
    `);
    console.log("✅ База данных SQLite успешно инициализирована!");
}
initDB();

// Вспомогательная функция для сохранения Base64 в файл
function saveBase64ToFile(base64String, extensionHint) {
    const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return null;
    
    const buffer = Buffer.from(matches[2], 'base64');
    let ext = extensionHint.split('.').pop();
    if (ext === extensionHint) ext = matches[1].split('/')[1] || 'bin'; 
    
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    
    fs.writeFileSync(filePath, buffer);
    return `/uploads/${fileName}`;
}

// --- API ДЛЯ ПРИВЯЗКИ TELEGRAM ---
app.get('/api/generate-tg-token', (req, res) => {
    const token = 'bind_' + Math.random().toString(36).substr(2, 9);
    pendingTgBinds[token] = { bound: false, chatId: null };
    // Удаляем токен через 10 минут, если не привязали
    setTimeout(() => delete pendingTgBinds[token], 10 * 60 * 1000);
    res.json({ token });
});

app.get('/api/check-tg-token', (req, res) => {
    const token = req.query.token;
    if (pendingTgBinds[token] && pendingTgBinds[token].bound) {
        const chatId = pendingTgBinds[token].chatId;
        delete pendingTgBinds[token]; // Удаляем после успешного использования
        res.json({ bound: true, chatId });
    } else {
        res.json({ bound: false });
    }
});


// --- МАРШРУТЫ ДЛЯ АВТОРИЗАЦИИ ---

app.post('/api/check-user', (req, res) => {
    const { loginId } = req.body;
    const users = readData(USERS_FILE);
    let targetUsername = null;
    let targetUser = null;

    for (const uname in users) {
        if (uname.toLowerCase() === loginId.toLowerCase() || 
           (users[uname].email && users[uname].email.toLowerCase() === loginId.toLowerCase())) {
            targetUsername = uname;
            targetUser = users[uname];
            break;
        }
    }

    if (targetUser) {
        res.json({ exists: true, username: targetUsername, hasEmail: !!targetUser.email, hasTelegram: !!targetUser.telegram });
    } else {
        res.json({ exists: false });
    }
});

app.post('/api/send-auth-code', async (req, res) => {
    const { username, method, isReset } = req.body;
    const users = readData(USERS_FILE);
    const user = users[username];
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    verificationCodes[username] = { code, timestamp: Date.now() };

    if (method === 'telegram' && user.telegram) {
        // Теперь user.telegram хранит надежный числовой ID (chatId)
        const chatId = user.telegram;
        const text = isReset ? `🔐 Код для сброса пароля Aura: *${code}*` : `🔑 Ваш код для входа в Aura: *${code}*`;
        try {
            await tgBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            return res.json({ success: true, message: 'Код отправлен в Telegram' });
        } catch (err) {
            return res.status(500).json({ error: 'Ошибка отправки в Telegram' });
        }
    } else if (method === 'email' && user.email) {
        try {
            const response = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: { 
                    'accept': 'application/json', 
                    'api-key': process.env.BREVO_API_KEY || '', 
                    'content-type': 'application/json' 
                },
                body: JSON.stringify({
                    sender: { name: "Aura Messenger", email: "auramessengercode@gmail.com" },
                    to: [{ email: user.email }],
                    subject: isReset ? "Сброс пароля Aura Messenger" : "Код подтверждения Aura Messenger",
                    htmlContent: getEmailTemplate(code), 
                    textContent: `Здравствуйте! Ваш код: ${code}`
                })
            });

            if (response.ok) {
                res.status(200).json({ success: true, message: 'Код отправлен на E-mail' });
            } else {
                res.status(200).json({ success: true, message: 'Режим отладки: письмо не ушло' });
            }
        } catch (error) { 
            res.status(200).json({ success: true, message: 'Режим отладки: ошибка сети' }); 
        }
    } else {
        res.status(400).json({ error: 'Неверный метод или контакт не привязан' });
    }
});

app.post('/api/verify-code', (req, res) => {
    const { username, code } = req.body;
    const pending = verificationCodes[username];
    if (!pending || pending.code !== code) return res.status(400).json({ error: 'Неверный или просроченный код' });
    
    delete verificationCodes[username];
    const users = readData(USERS_FILE);
    const user = users[username];

    if (user) { 
        req.session.username = username; 
        res.json({ isNewUser: false, user: { username, ...user } }); 
    } else { 
        res.json({ isNewUser: true }); 
    }
});

app.post('/api/login-password', async (req, res) => {
    const { loginId, password } = req.body;
    const users = readData(USERS_FILE);
    let username = null;
    let user = null;
    
    for (const uname in users) {
        if (uname.toLowerCase() === loginId.toLowerCase() || 
           (users[uname].email && users[uname].email.toLowerCase() === loginId.toLowerCase())) {
            username = uname; 
            user = users[uname]; 
            break;
        }
    }
    
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Неверный логин или пароль' });
    
    req.session.username = username;
    res.json({ success: true, user: { username, name: user.name, avatar: user.avatar } });
});

app.post('/api/register-final', async (req, res) => {
    const { fullname, username, email, telegramId, password } = req.body;
    const users = readData(USERS_FILE);
    
    if (users[username]) return res.status(400).json({ error: 'Этот логин уже занят' });

    users[username] = {
        password: await bcrypt.hash(password, 10), 
        email: email || null, 
        telegram: telegramId, 
        name: fullname, 
        avatar: null, 
        bio: '', 
        birthday: '', 
        profilePattern: 'none',
        contacts: [], 
        blocked: [], 
        lastSeen: Date.now()
    };

    writeData(USERS_FILE, users);
    req.session.username = username;
    res.json({ success: true, user: { username, name: fullname } });
});

app.post('/api/reset-password', async (req, res) => {
    const { username, code, newPassword } = req.body;
    const pending = verificationCodes[username];
    
    if (!pending || pending.code !== code) return res.status(400).json({ error: 'Неверный код' });

    const users = readData(USERS_FILE);
    users[username].password = await bcrypt.hash(newPassword, 10);
    writeData(USERS_FILE, users);
    
    delete verificationCodes[username];
    req.session.username = username;
    res.json({ success: true });
});

app.get('/logout', (req, res) => { 
    req.session.destroy(); 
    res.redirect('/auth.html'); 
});

app.get('/my-full-profile', (req, res) => {
    if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
    const users = readData(USERS_FILE);
    const user = users[req.session.username];
    
    if (!user) return res.status(404).json({ error: 'Not found' });
    
    const { password, ...safeUser } = user;
    res.json({ username: req.session.username, ...safeUser });
});

app.post('/update-profile', (req, res) => {
    if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
    const users = readData(USERS_FILE);
    const user = users[req.session.username];
    
    if (!user) return res.status(404).json({ error: 'Not found' });
    
    if (req.body.name !== undefined) user.name = req.body.name;
    if (req.body.bio !== undefined) user.bio = req.body.bio;
    if (req.body.birthday !== undefined) user.birthday = req.body.birthday;
    if (req.body.avatar !== undefined) user.avatar = req.body.avatar;
    if (req.body.profilePattern !== undefined) user.profilePattern = req.body.profilePattern;
    
    writeData(USERS_FILE, users);
    res.json({ success: true });
});

app.get('/api/entity/:id', (req, res) => {
    const callerId = req.session.username;
    const id = req.params.id;
    const users = readData(USERS_FILE);
    const groups = readData(GROUPS_FILE);
    const caller = users[callerId];

    if (groups[id]) {
        const group = groups[id];
        return res.json({
            type: 'group', 
            id: group.id, 
            name: group.name, 
            displayName: group.name,
            description: group.description, 
            avatar: group.avatar, 
            membersCount: group.members.length,
            isCreator: group.creator === callerId, 
            isOnline: false, 
            lastSeen: null, 
            membersList: []
        });
    }

    const user = users[id];
    if (!user) return res.status(404).json({ error: 'Not found' });

    let displayName = user.name || id;
    let inContacts = false;
    
    if (caller && caller.contacts) {
        const contactObj = caller.contacts.find(c => typeof c === 'object' ? c.username === id : c === id);
        if (contactObj) {
            inContacts = true;
            if (typeof contactObj === 'object' && contactObj.customName) displayName = contactObj.customName;
        }
    }

    const isBlocked = caller && caller.blocked && caller.blocked.includes(id);

    res.json({
        type: 'user', 
        username: id, 
        name: user.name, 
        displayName: displayName,
        avatar: user.avatar, 
        bio: user.bio, 
        birthday: user.birthday, 
        profilePattern: user.profilePattern,
        isOnline: !!onlineUsers[id], 
        lastSeen: user.lastSeen, 
        isBlocked: isBlocked, 
        inContacts: inContacts
    });
});

// --- WebSocket Логика ---
const onlineUsers = {}; 

io.on('connection', (socket) => {
    let currentUsername = null;

    socket.on('identify', (username) => {
        currentUsername = username;
        onlineUsers[username] = socket.id;
        const users = readData(USERS_FILE);
        if (users[username]) { 
            users[username].lastSeen = 'online'; 
            writeData(USERS_FILE, users); 
        }
        io.emit('user_status_change', { username, online: true, lastSeen: 'online' });
    });

    socket.on('search_user', (searchUsername) => {
        const users = readData(USERS_FILE);
        if (users[searchUsername]) socket.emit('search_result', { exists: true, username: searchUsername });
        else socket.emit('search_result', { exists: false });
    });

    socket.on('get_my_chats', async () => {
        if (!currentUsername) return;
        const users = readData(USERS_FILE);
        const groups = readData(GROUPS_FILE);
        const myUser = users[currentUsername];
        let chats = new Set();
        
        const rows = await db.all(`SELECT fromUser, toUser FROM messages WHERE fromUser = ? OR toUser = ?`, [currentUsername, currentUsername]);
        
        rows.forEach(r => {
            if (r.fromUser === currentUsername && !groups[r.toUser]) chats.add(r.toUser);
            if (r.toUser === currentUsername && !groups[r.fromUser]) chats.add(r.fromUser);
        });
        
        if (myUser && myUser.contacts) {
            myUser.contacts.forEach(c => chats.add(typeof c === 'object' ? c.username : c));
        }
        
        chats.delete(currentUsername);
        let chatsArray = Array.from(chats);

        for (const groupId in groups) {
            if (groups[groupId].members.includes(currentUsername)) chatsArray.push(groupId);
        }
        
        socket.emit('my_chats_list', chatsArray);
    });

    // ПАГИНАЦИЯ (Бесконечный скролл)
    socket.on('get_history', async (data) => {
        if (!currentUsername) return;
        const chatWith = data.chatWith;
        const offset = data.offset || 0; 
        const groups = readData(GROUPS_FILE);
        const users = readData(USERS_FILE);
        const myUser = users[currentUsername];

        let historyRows = [];
        
        if (chatWith === 'me') {
            historyRows = await db.all(`SELECT * FROM messages WHERE fromUser = ? AND toUser = 'me' ORDER BY id DESC LIMIT 40 OFFSET ?`, [currentUsername, offset]);
        } else if (groups[chatWith]) {
            historyRows = await db.all(`SELECT * FROM messages WHERE toUser = ? ORDER BY id DESC LIMIT 40 OFFSET ?`, [chatWith, offset]);
            // Отправляем закрепленное сообщение при первой загрузке
            if (offset === 0) {
                const pinnedRow = await db.get(`SELECT * FROM messages WHERE toUser = ? AND isPinned = 1 ORDER BY id DESC LIMIT 1`, [chatWith]);
                if (pinnedRow) socket.emit('msg_pinned', { id: pinnedRow.id, text: pinnedRow.text, chatId: chatWith });
            }
        } else {
            historyRows = await db.all(`SELECT * FROM messages WHERE (fromUser = ? AND toUser = ?) OR (fromUser = ? AND toUser = ?) ORDER BY id DESC LIMIT 40 OFFSET ?`, 
                [currentUsername, chatWith, chatWith, currentUsername, offset]);
        }

        historyRows.reverse(); 

        let history = historyRows.map(r => {
            let deletedFor = r.deletedFor ? JSON.parse(r.deletedFor) : [];
            if (deletedFor.includes(currentUsername)) return null; 

            let fromDisplayName = r.fromUser;
            if (r.fromUser !== currentUsername && groups[chatWith]) {
                const contactObj = myUser.contacts ? myUser.contacts.find(c => (typeof c === 'object' ? c.username : c) === r.fromUser) : null;
                if (contactObj && typeof contactObj === 'object' && contactObj.customName) fromDisplayName = contactObj.customName;
                else if (users[r.fromUser] && users[r.fromUser].name) fromDisplayName = users[r.fromUser].name;
            }

            return {
                id: r.id, 
                from: r.fromUser, 
                to: r.toUser, 
                text: r.text, 
                time: r.time, 
                read: r.isRead === 1,
                isEdited: r.isEdited === 1,
                media: r.mediaType ? { type: r.mediaType, data: r.mediaData, name: r.mediaName } : null,
                reply: r.replyData ? JSON.parse(r.replyData) : null,
                reactions: r.reactions ? JSON.parse(r.reactions) : {},
                deletedFor: deletedFor,
                fromDisplayName: fromDisplayName
            };
        }).filter(m => m !== null);

        socket.emit('chat_history', { history, offset, chatWith });
    });

    // ПОИСК СООБЩЕНИЙ
    socket.on('search_chat', async (data) => {
        if (!currentUsername) return;
        const groups = readData(GROUPS_FILE);
        let query = `%${data.query}%`;
        let historyRows = [];

        if (groups[data.chatWith]) {
            historyRows = await db.all(`SELECT * FROM messages WHERE toUser = ? AND text LIKE ? ORDER BY id DESC LIMIT 100`, [data.chatWith, query]);
        } else {
            historyRows = await db.all(`SELECT * FROM messages WHERE ((fromUser = ? AND toUser = ?) OR (fromUser = ? AND toUser = ?)) AND text LIKE ? ORDER BY id DESC LIMIT 100`, 
                [currentUsername, data.chatWith, data.chatWith, currentUsername, query]);
        }
        historyRows.reverse();
        
        let history = historyRows.map(r => ({
            id: r.id, from: r.fromUser, to: r.toUser, text: r.text, time: r.time, read: r.isRead===1, isEdited: r.isEdited===1
        }));
        
        socket.emit('chat_history', { history, offset: 0, chatWith: data.chatWith, isSearch: true });
    });

    socket.on('private_msg', async (data) => {
        if (!currentUsername) return;
        
        const msgId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        let finalMediaData = null;
        
        if (data.media && data.media.data && data.media.data.startsWith('data:')) {
            finalMediaData = saveBase64ToFile(data.media.data, data.media.name);
            data.media.data = finalMediaData;
        }

        const msg = {
            id: msgId,
            from: currentUsername,
            to: data.to,
            text: data.text || '',
            media: data.media || null,
            reply: data.reply || null,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            read: false, reactions: {}, isEdited: false, deletedFor: []
        };

        await db.run(`INSERT INTO messages 
            (id, fromUser, toUser, text, mediaType, mediaData, mediaName, replyData, time, isRead, isEdited, isPinned, reactions, deletedFor) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '{}', '[]')`,
            [
                msg.id, msg.from, msg.to, msg.text,
                msg.media ? msg.media.type : null,
                msg.media ? msg.media.data : null,
                msg.media ? msg.media.name : null,
                msg.reply ? JSON.stringify(msg.reply) : null,
                msg.time
            ]
        );

        const users = readData(USERS_FILE);
        const groups = readData(GROUPS_FILE);
        const myUser = users[currentUsername];

        if (groups[data.to]) {
            groups[data.to].members.forEach(memberUsername => {
                if (memberUsername === currentUsername) {
                    socket.emit('msg_receive', msg);
                } else if (onlineUsers[memberUsername]) {
                    const memberUser = users[memberUsername];
                    let fromDisplayName = currentUsername;
                    if (memberUser && memberUser.contacts) {
                        const contactObj = memberUser.contacts.find(c => (typeof c === 'object' ? c.username : c) === currentUsername);
                        if (contactObj && typeof contactObj === 'object' && contactObj.customName) fromDisplayName = contactObj.customName;
                        else if (myUser && myUser.name) fromDisplayName = myUser.name;
                    }
                    io.to(onlineUsers[memberUsername]).emit('msg_receive', { ...msg, fromDisplayName });
                }
            });
        } else {
            socket.emit('msg_receive', msg);
            if (data.to !== 'me' && data.to !== currentUsername && onlineUsers[data.to]) {
                const recipient = users[data.to];
                if (!(recipient.blocked && recipient.blocked.includes(currentUsername))) {
                    io.to(onlineUsers[data.to]).emit('msg_receive', msg);
                }
            }
        }
    });

    // РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
    socket.on('edit_msg', async (data) => {
        if (!currentUsername) return;
        await db.run(`UPDATE messages SET text = ?, isEdited = 1 WHERE id = ? AND fromUser = ?`, [data.text, data.id, currentUsername]);
        io.emit('msg_edited', { id: data.id, text: data.text });
    });

    // ЗАКРЕПЛЕНИЕ СООБЩЕНИЯ
    socket.on('pin_msg', async (data) => {
        if (!currentUsername) return;
        await db.run(`UPDATE messages SET isPinned = 0 WHERE toUser = ?`, [data.chatId]);
        await db.run(`UPDATE messages SET isPinned = 1 WHERE id = ?`, [data.id]);
        io.emit('msg_pinned', { id: data.id, text: data.text, chatId: data.chatId });
    });

    socket.on('mark_read', async (data) => {
        if (!currentUsername) return;
        const groups = readData(GROUPS_FILE);
        
        if (groups[data.chatWith]) {
            await db.run(`UPDATE messages SET isRead = 1 WHERE toUser = ? AND fromUser != ? AND isRead = 0`, [data.chatWith, currentUsername]);
        } else {
            const rows = await db.all(`SELECT fromUser FROM messages WHERE fromUser = ? AND toUser = ? AND isRead = 0`, [data.chatWith, currentUsername]);
            if (rows.length > 0) {
                await db.run(`UPDATE messages SET isRead = 1 WHERE fromUser = ? AND toUser = ?`, [data.chatWith, currentUsername]);
                if (onlineUsers[data.chatWith]) io.to(onlineUsers[data.chatWith]).emit('messages_read', { by: currentUsername });
            }
        }
    });

    socket.on('typing', (data) => {
        const groups = readData(GROUPS_FILE);
        if (groups[data.to]) {
            groups[data.to].members.forEach(member => {
                if (member !== currentUsername && onlineUsers[member]) io.to(onlineUsers[member]).emit('user_typing', { from: currentUsername, to: data.to });
            });
        } else if (onlineUsers[data.to]) {
            io.to(onlineUsers[data.to]).emit('user_typing', { from: currentUsername, to: currentUsername });
        }
    });

    socket.on('stop_typing', (data) => {
        const groups = readData(GROUPS_FILE);
        if (groups[data.to]) {
            groups[data.to].members.forEach(member => {
                if (member !== currentUsername && onlineUsers[member]) io.to(onlineUsers[member]).emit('user_stop_typing', { from: currentUsername, to: data.to });
            });
        } else if (onlineUsers[data.to]) {
            io.to(onlineUsers[data.to]).emit('user_stop_typing', { from: currentUsername, to: currentUsername });
        }
    });

    socket.on('toggle_contact', (data) => {
        if (!currentUsername) return;
        const users = readData(USERS_FILE);
        if (!users[currentUsername].contacts) users[currentUsername].contacts = [];
        let contacts = users[currentUsername].contacts.filter(c => (typeof c === 'object' ? c.username : c) !== data.username);
        if (!data.remove) contacts.push({ username: data.username, customName: data.customName || data.username });
        users[currentUsername].contacts = contacts;
        writeData(USERS_FILE, users);
        socket.emit('contact_toggled', { username: data.username, inContacts: !data.remove });
    });

    socket.on('toggle_block', (data) => {
        if (!currentUsername) return;
        const users = readData(USERS_FILE);
        if (!users[currentUsername].blocked) users[currentUsername].blocked = [];
        const idx = users[currentUsername].blocked.indexOf(data.username);
        let isBlocked = false;
        if (idx === -1) { users[currentUsername].blocked.push(data.username); isBlocked = true; } 
        else { users[currentUsername].blocked.splice(idx, 1); }
        writeData(USERS_FILE, users);
        socket.emit('block_toggled', { username: data.username, isBlocked });
        if (onlineUsers[data.username]) {
            io.to(onlineUsers[data.username]).emit('user_status_change', { username: currentUsername, online: !isBlocked, lastSeen: isBlocked ? 'blocked' : 'online' });
        }
    });

    socket.on('create_group', (data) => {
        if (!currentUsername) return;
        const groups = readData(GROUPS_FILE);
        if (groups[data.id]) { socket.emit('error', 'Группа с таким ID уже существует'); return; }

        let members = [...new Set([currentUsername, ...data.members])].slice(0, 100);
        groups[data.id] = { id: data.id, name: data.name, description: data.description || '', avatar: data.avatar || null, creator: currentUsername, members: members };
        writeData(GROUPS_FILE, groups);
        socket.emit('group_created', { groupId: data.id });
        members.forEach(member => { if (member !== currentUsername && onlineUsers[member]) io.to(onlineUsers[member]).emit('search_result', { exists: true, username: data.id }); });
    });

    socket.on('leave_group', (data) => {
        if (!currentUsername) return;
        const groups = readData(GROUPS_FILE);
        if (groups[data.groupId]) {
            groups[data.groupId].members = groups[data.groupId].members.filter(m => m !== currentUsername);
            if (groups[data.groupId].members.length === 0) delete groups[data.groupId];
            writeData(GROUPS_FILE, groups);
            socket.emit('get_my_chats');
        }
    });

    socket.on('add_reaction', async (data) => {
        if (!currentUsername) return;
        const row = await db.get(`SELECT reactions FROM messages WHERE id = ?`, [data.id]);
        if (row) {
            let reactions = row.reactions ? JSON.parse(row.reactions) : {};
            reactions[data.emoji] = reactions[data.emoji] || [];
            
            const userIdx = reactions[data.emoji].indexOf(currentUsername);
            if (userIdx > -1) reactions[data.emoji].splice(userIdx, 1);
            else reactions[data.emoji].push(currentUsername);
            
            await db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), data.id]);
            io.emit('msg_reaction_update', { id: data.id, reactions: reactions });
        }
    });

    socket.on('delete_msg', async (data) => {
        if (!currentUsername) return;
        const groups = readData(GROUPS_FILE);
        const msg = await db.get(`SELECT * FROM messages WHERE id = ?`, [data.id]);
        
        if (msg) {
            const recipient = msg.toUser === currentUsername ? msg.fromUser : msg.toUser;
            
            if (data.forEveryone && msg.fromUser === currentUsername) {
                await db.run(`DELETE FROM messages WHERE id = ?`, [data.id]);
                if (groups[recipient]) {
                    groups[recipient].members.forEach(member => {
                        if (onlineUsers[member]) io.to(onlineUsers[member]).emit('msg_deleted', { id: data.id });
                    });
                } else {
                    socket.emit('msg_deleted', { id: data.id });
                    if (onlineUsers[recipient]) io.to(onlineUsers[recipient]).emit('msg_deleted', { id: data.id });
                }
            } else {
                let deletedFor = msg.deletedFor ? JSON.parse(msg.deletedFor) : [];
                if (!deletedFor.includes(currentUsername)) {
                    deletedFor.push(currentUsername);
                    await db.run(`UPDATE messages SET deletedFor = ? WHERE id = ?`, [JSON.stringify(deletedFor), data.id]);
                }
                socket.emit('msg_deleted', { id: data.id });
            }
        }
    });

    socket.on('disconnect', () => {
        if (currentUsername) {
            const users = readData(USERS_FILE);
            const now = Date.now();
            if (users[currentUsername]) { 
                users[currentUsername].lastSeen = now; 
                writeData(USERS_FILE, users); 
            }
            delete onlineUsers[currentUsername];
            io.emit('user_status_change', { username: currentUsername, online: false, lastSeen: now });
        }
    });
});

// --- ЗАПУСК СЕРВЕРА С PEERJS ---
const PORT = process.env.PORT || 3000;
const peerServer = ExpressPeerServer(server, { 
    debug: true, 
    path: '/' 
});
app.use('/peerjs', peerServer);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}. Telegram бот и сервер звонков активны.`);
});
