const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // Увеличение буфера для Socket.IO (10MB)
});

// --- Настройка лимитов для загрузки больших фото (Base64) ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(__dirname));
app.use(session({
    secret: 'aura-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Сессия на 1 день
}));

const USERS_FILE = './users.json';
const MESSAGES_FILE = './messages.json';

// --- Работа с данными ---
const readData = (file) => {
    if (!fs.existsSync(file)) return file === USERS_FILE ? {} : [];
    try { 
        const data = fs.readFileSync(file, 'utf8');
        return data ? JSON.parse(data) : (file === USERS_FILE ? {} : []); 
    } catch (e) { 
        return file === USERS_FILE ? {} : []; 
    }
};

const writeData = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const onlineUsers = {};

// --- Авторизация ---
app.post('/register', async (req, res) => {
    const { username, password, name } = req.body;
    const users = readData(USERS_FILE);
    if (users[username]) return res.status(400).json({error: "Ник занят"});
    const hashedPassword = await bcrypt.hash(password, 10);
    users[username] = { name, password: hashedPassword, avatar: "" };
    writeData(USERS_FILE, users);
    req.session.user = { username, name, avatar: "" };
    res.json({success: true});
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const users = readData(USERS_FILE);
    const user = users[username];
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { username, name: user.name, avatar: user.avatar || "" };
        res.json({success: true});
    } else { res.status(400).json({error: "Ошибка входа"}); }
});

app.get('/me', (req, res) => res.json(req.session.user || {}));
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/auth.html');
});

// --- Профили ---
app.get('/user/:username', (req, res) => {
    const users = readData(USERS_FILE);
    const user = users[req.params.username];
    if (user) {
        res.json({
            name: user.name,
            avatar: user.avatar || "",
            username: req.params.username
        });
    } else {
        res.status(404).json({error: "Пользователь не найден"});
    }
});

app.post('/update-profile', (req, res) => {
    if (!req.session.user) return res.status(401).json({error: "Не авторизован"});
    const { name, avatar } = req.body;
    const users = readData(USERS_FILE);
    const username = req.session.user.username;

    if (users[username]) {
        users[username].name = name || users[username].name;
        users[username].avatar = avatar || users[username].avatar;
        writeData(USERS_FILE, users);
        
        // Обновляем данные в текущей сессии
        req.session.user.name = users[username].name;
        req.session.user.avatar = users[username].avatar;
        res.json({success: true});
    } else {
        res.status(404).json({error: "Пользователь не найден"});
    }
});

// --- Сокеты ---
io.on('connection', (socket) => {
    let currentUsername = "";

    socket.on('identify', (username) => {
        currentUsername = username;
        onlineUsers[username] = socket.id;
        console.log(`@${username} в сети`);
    });

    socket.on('search_user', (targetUsername) => {
        const users = readData(USERS_FILE);
        if (users[targetUsername]) {
            socket.emit('search_result', { exists: true, username: targetUsername });
        } else {
            socket.emit('search_result', { exists: false });
        }
    });

    socket.on('get_my_chats', () => {
        if (!currentUsername) return;
        const allMsgs = readData(MESSAGES_FILE);
        const chatPartners = new Set();
        allMsgs.forEach(m => {
            if (m.from === currentUsername) chatPartners.add(m.to);
            if (m.to === currentUsername) chatPartners.add(m.from);
        });
        socket.emit('my_chats_list', Array.from(chatPartners));
    });

    socket.on('get_history', (otherUser) => {
        const allMsgs = readData(MESSAGES_FILE);
        const chatHistory = allMsgs.filter(m => 
            (m.from === currentUsername && m.to === otherUser) || 
            (m.from === otherUser && m.to === currentUsername)
        );
        socket.emit('chat_history', chatHistory);
    });

    // ОБНОВЛЕННЫЙ ПРИЕМ СООБЩЕНИЙ С ПОДДЕРЖКОЙ ОТВЕТОВ
    socket.on('private_msg', (data) => {
        if (!currentUsername) return;
        
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        // Формируем объект сообщения
        const msg = { 
            from: currentUsername,
            to: data.to,
            text: data.text,
            reply: data.reply || null, // Добавляем данные об ответе (если есть)
            time: time 
        };

        const allMsgs = readData(MESSAGES_FILE);
        allMsgs.push(msg);
        writeData(MESSAGES_FILE, allMsgs);

        // Отправка получателю
        if (onlineUsers[data.to]) {
            io.to(onlineUsers[data.to]).emit('msg_receive', msg);
        }
        // Отправка отправителю (подтверждение)
        socket.emit('msg_receive', msg);
    });

    socket.on('disconnect', () => {
        if (currentUsername) {
            delete onlineUsers[currentUsername];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
