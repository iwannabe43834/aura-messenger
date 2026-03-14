const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8, // Увеличил до 100МБ для надежности
    cors: { origin: "*" }   // Render иногда блокирует сокеты без этой строчки
});

// --- Настройка почты ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'auramessengercode@gmail.com', 
        pass: 'jcxi laqa dlmv vaji' 
    }
});

const recoveryCodes = {};

// --- Настройки сервера ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

app.use(session({
    secret: 'aura-secret-key-1337',
    resave: true,
    saveUninitialized: false,
    cookie: { 
        maxAge: 7 * 24 * 60 * 60 * 1000,
        secure: false 
    }
}));

const USERS_FILE = path.join(__dirname, 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

const readData = (file) => {
    if (!fs.existsSync(file)) return file === USERS_FILE ? {} : [];
    try { 
        const data = fs.readFileSync(file, 'utf8');
        return data ? JSON.parse(data) : (file === USERS_FILE ? {} : []); 
    } catch (e) { return file === USERS_FILE ? {} : []; }
};

const writeData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const onlineUsers = {};

// --- API Роуты ---

app.post('/register', async (req, res) => {
    const { username, password, name, email } = req.body;
    if (!username || !password || !email) return res.status(400).json({error: "Заполните все поля"});
    
    const users = readData(USERS_FILE);
    if (users[username]) return res.status(400).json({error: "Никнейм уже занят"});
    
    const hashedPassword = await bcrypt.hash(password, 10);
    users[username] = { 
        name: name || username, 
        password: hashedPassword, 
        email: email,
        avatar: "" 
    };
    
    writeData(USERS_FILE, users);
    req.session.user = { username, name: users[username].name, avatar: "" };
    res.json({success: true});
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const users = readData(USERS_FILE);
    const user = users[username];
    
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { 
            username, 
            name: user.name, 
            avatar: user.avatar || "" 
        };
        req.session.save(() => res.json({success: true}));
    } else { 
        res.status(400).json({error: "Неверный логин или пароль"}); 
    }
});

app.post('/send-recovery-code', async (req, res) => {
    console.log(">>> [LOG]: Запрос на восстановление для:", req.body.email);
    
    try {
        const { email } = req.body;
        const users = readData(USERS_FILE);
        
        // 1. Ищем пользователя
        const username = Object.keys(users).find(u => users[u].email === email);
        if (!username) {
            console.log(">>> [LOG]: Email не найден в базе");
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        // 2. Генерируем код
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        recoveryCodes[email] = { code, username };

        // 3. Настройка письма
        const mailOptions = {
            from: '"Aura Messenger" <auramessengercode@gmail.com>',
            to: email,
            subject: 'Код восстановления Aura',
            text: `Ваш код: ${code}. Никнейм: @${username}`
        };

        console.log(">>> [LOG]: Пытаюсь отправить через Gmail...");

        // 4. Отправка с использованием await (обязательно!)
        const info = await transporter.sendMail(mailOptions);
        
        console.log(">>> [LOG]: Письмо отправлено успешно:", info.response);
        return res.json({ success: true });

    } catch (error) {
        // ЭТОТ БЛОК ВЫВЕДЕТ ОШИБКУ В РЕНДЕР, ЕСЛИ ЧТО-ТО НЕ ТАК
        console.error(">>> [ERROR] ОШИБКА ПОЧТЫ:");
        console.error("Текст ошибки:", error.message);
        console.error("Код ошибки:", error.code);
        
        return res.status(500).json({ 
            error: "Сервер не смог отправить письмо", 
            details: error.message 
        });
    }
});

app.post('/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;
    const record = recoveryCodes[email];
    if (record && record.code == code) {
        const users = readData(USERS_FILE);
        users[record.username].password = await bcrypt.hash(newPassword, 10);
        writeData(USERS_FILE, users);
        delete recoveryCodes[email];
        res.json({success: true});
    } else {
        res.status(400).json({error: "Неверный код"});
    }
});

app.get('/me', (req, res) => {
    if (req.session.user) res.json(req.session.user);
    else res.status(401).json({});
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/auth.html');
});

app.get('/user/:username', (req, res) => {
    const users = readData(USERS_FILE);
    const user = users[req.params.username];
    if (user) {
        res.json({ username: req.params.username, name: user.name, avatar: user.avatar || "" });
    } else { res.status(404).json({error: "Не найден"}); }
});

app.post('/update-profile', (req, res) => {
    if (!req.session.user) return res.status(401).json({error: "Не авторизован"});
    const { name, avatar } = req.body;
    const users = readData(USERS_FILE);
    const username = req.session.user.username;
    if (users[username]) {
        if (name) users[username].name = name;
        if (avatar !== undefined) users[username].avatar = avatar;
        writeData(USERS_FILE, users);
        req.session.user.name = users[username].name;
        req.session.user.avatar = users[username].avatar;
        res.json({success: true});
    } else { res.status(404).json({error: "Не найден"}); }
});

// --- Socket.IO Логика ---

io.on('connection', (socket) => {
    let currentUsername = "";

    socket.on('identify', (username) => {
        currentUsername = username;
        onlineUsers[username] = socket.id;
    });

    socket.on('search_user', (targetUsername) => {
        const users = readData(USERS_FILE);
        socket.emit('search_result', { exists: !!users[targetUsername], username: targetUsername });
    });

    socket.on('get_my_chats', () => {
        if (!currentUsername) return;
        const allMsgs = readData(MESSAGES_FILE);
        const chatPartners = new Set();
        allMsgs.forEach(m => {
            if (m.from === currentUsername && m.to !== currentUsername && m.to !== 'me') chatPartners.add(m.to);
            if (m.to === currentUsername && m.from !== currentUsername) chatPartners.add(m.from);
        });
        socket.emit('my_chats_list', Array.from(chatPartners));
    });

    socket.on('get_history', (otherUser) => {
        if (!currentUsername) return;
        const allMsgs = readData(MESSAGES_FILE);
        
        let chatHistory;
        if (otherUser === 'me' || otherUser === currentUsername) {
            chatHistory = allMsgs.filter(m => 
                (m.from === currentUsername && m.to === 'me') || 
                (m.from === currentUsername && m.to === currentUsername)
            );
        } else {
            chatHistory = allMsgs.filter(m => 
                (m.from === currentUsername && m.to === otherUser) || 
                (m.from === otherUser && m.to === currentUsername)
            );
        }
        socket.emit('chat_history', chatHistory);
    });

    socket.on('private_msg', (data) => {
        if (!currentUsername || !data.to) return;

        const msg = { 
            id: Date.now() + Math.random().toString(36).substr(2, 9), // Уникальный ID
            from: currentUsername, 
            to: data.to, 
            text: data.text || "",
            media: data.media || null,
            reply: data.reply || null,
            read: false, // Новое сообщение не прочитано
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        };

        const allMsgs = readData(MESSAGES_FILE);
        allMsgs.push(msg);
        writeData(MESSAGES_FILE, allMsgs);

        // Отправка получателю и себе
        if (data.to === 'me' || data.to === currentUsername) {
            socket.emit('msg_receive', msg);
        } else {
            if (onlineUsers[data.to]) {
                io.to(onlineUsers[data.to]).emit('msg_receive', msg);
            }
            socket.emit('msg_receive', msg);
        }
    });

    // --- Логика статуса "Прочитано" ---
    socket.on('mark_read', (data) => {
        const { chatWith } = data;
        let allMsgs = readData(MESSAGES_FILE);
        let changed = false;

        allMsgs = allMsgs.map(m => {
            if (m.from === chatWith && m.to === currentUsername && !m.read) {
                m.read = true;
                changed = true;
            }
            return m;
        });

        if (changed) {
            writeData(MESSAGES_FILE, allMsgs);
            if (onlineUsers[chatWith]) {
                io.to(onlineUsers[chatWith]).emit('messages_read', { by: currentUsername });
            }
        }
    });

    // --- Логика удаления сообщения ---
    socket.on('delete_msg', (msgId) => {
        let allMsgs = readData(MESSAGES_FILE);
        const msgToDelete = allMsgs.find(m => m.id === msgId);
        
        if (msgToDelete && msgToDelete.from === currentUsername) {
            const recipient = msgToDelete.to;
            allMsgs = allMsgs.filter(m => m.id !== msgId);
            writeData(MESSAGES_FILE, allMsgs);

            // Уведомляем обоих участников об удалении
            socket.emit('msg_deleted', msgId);
            if (onlineUsers[recipient]) {
                io.to(onlineUsers[recipient]).emit('msg_deleted', msgId);
            }
        }
    });

    socket.on('disconnect', () => {
        if (currentUsername) delete onlineUsers[currentUsername];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aura Messenger Pro запущен на порту ${PORT}`);
});
