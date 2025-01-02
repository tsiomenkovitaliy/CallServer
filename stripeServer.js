const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Модель пользователя
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  token: { type: String, unique: true, required: true },
  userId: { type: String, unique: true, required: true }, 
  socketId: { type: String, default: null },
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
});

// В объекте храните таймеры отключений для каждого userId
const disconnectTimers = {}; 
const DISCONNECT_DELAY = 10000; // 5 секунд на переподключение

const User = mongoose.model('User', UserSchema);
const Call = require('./models/Call'); // путь к файлу, где вы создали модель

// Подключение к MongoDB
mongoose.connect('mongodb+srv://tciomenko:XEgWRMLsYJY6P7v7@cluster0.at6au.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// HTTP-сервер и WebSocket
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Настройте CORS по необходимости
  },
});

// Мидлвэр для аутентификации Socket.IO
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      return next(new Error('Authentication error: token is missing'));
    }

    const user = await User.findOne({ token });
    if (!user) {
      return next(new Error('Invalid token'));
    }

    socket.user = user; // Привязываем пользователя к сокету
    next();
  } catch (err) {
    console.error('Socket.IO middleware error:', err);
    return next(new Error('Internal server error'));
  }
});

// События подключения и работы с пользователями
io.on('connection', async (socket) => {
  try {
    const user = socket.user;

    // Если у пользователя был таймер на дисконнект, сбросим его
    if (disconnectTimers[user.userId]) {
      clearTimeout(disconnectTimers[user.userId]);
      delete disconnectTimers[user.userId];
    }
    // if (user.socketId != null) {
    //   console.log(`Reconnect user: ${user.username}`);

    //   socket.to(socket.id).emit('reconnect', {
    //     _id: user._id, 
    //     userId: user.userId,
    //     username: user.username,
    //     status: user.status,
    //   });
    // }

    // Обновляем socketId и статус пользователя
    user.socketId = socket.id;
    user.status = 'online';
    await user.save();

    console.log(`User ${user.username} connected, socketId: ${socket.id}`);

    // Уведомляем других пользователей о подключении
    socket.broadcast.emit('user-connected', {
      _id: user._id, // Передаём userId
      userId: user.userId,
      username: user.username,
      status: user.status,
    });

    // Отправляем текущему пользователю список всех пользователей (кроме него самого)
    const users = await User.find({ _id: { $ne: user._id } }, 'username status userId');
    socket.emit('user-list', users);

    // Пример использования при старте звонка
    socket.on('start-call', async ({ targetUserId, callUUID }) => {
      const targetUser = await User.findOne({ userId: targetUserId });
      if (targetUser && targetUser.status === 'online' && targetUser.socketId) {
        console.log(`Call initiated: ${callUUID} from ${user.username} to ${targetUser.username}`);

        // Создаём запись о новом звонке в БД
        await Call.create({
          callUUID,
          callerId: user.userId,
          calleeId: targetUserId,
          // offerSdp, если уже есть
          // answerSdp, если уже есть
          status: 'pending'
        });

        // Уведомляем целевого пользователя о входящем звонке
        io.to(targetUser.socketId).emit('incoming-call', {
          callUUID,
          callerName: user.username,
          callerId: socket.user.userId,
          id: user._id
        });

        // Уведомляем инициатора, что звонок начат
        socket.emit('call-initiated', {
          callUUID,
          targetId: targetUserId,
        });
      } else {
        console.error(`Call error: Target user is offline or not found (${targetUserId})`);
        socket.emit('call-error', { message: 'User is offline or not found' });
      }
    });

    // Завершение звонка
    socket.on('end-call', async ({ targetUserId, callUUID }) => {
      const targetUser = await User.findOne({ userId: targetUserId });
      if (targetUser && targetUser.socketId) {
        console.log(`Call ended: ${callUUID} between ${user.username} and ${targetUser.username}`);

        // Уведомляем целевого пользователя, что звонок завершён
        io.to(targetUser.socketId).emit('call-ended', { callUUID });
      }
    });

    // Обработка WebRTC сигналов
    socket.on('signal', (data) => {
   
      User.findOne({ userId: data.targetUserId }).then((targetUser) => {
         if (targetUser && targetUser.socketId) {
            io.to(targetUser.socketId).emit('signal', {
               senderId: user.userId,
               signal: data.signal || null,
               candidate: data.candidate || null,
            });
            console.log(`Signal sent from ${user.username} to ${targetUser.username}`);
         } else {
            console.error(`Signal error: Target user is offline or not found (${targetUserId})`);
         }
      });
   });

    // Обработка отключения
    socket.on('disconnect', async () => {
      console.log(`User ${user.username} disconnected, socketId: ${socket.id}`);
  
      // Ставим таймер, во время которого ждём возможного реконнекта
      disconnectTimers[user.userId] = setTimeout(async () => {
        // Если за это время пользователь не переподключился, ставим офлайн
        console.log(`Setting user ${user.username} offline (no reconnection).`);
        user.status = 'offline';
        user.socketId = null;
        await user.save();
  
        // Сообщаем другим
        socket.broadcast.emit('user-disconnected', {
          id: user._id,
          userId: user.userId,
          username: user.username,
          status: user.status,
        });
  
        // Удаляем таймер из памяти
        delete disconnectTimers[user.userId];
      }, DISCONNECT_DELAY);
    });
  } catch (err) {
    console.error('Error during connection handling:', err);
  }
});

// HTTP API для регистрации нового пользователя
app.post('/register', async (req, res) => {
  try {
    const { username, userId } = req.body;

    if (!username || !userId) {
      return res.status(400).json({ message: 'Username and userId are required' });
    }

    // Проверяем, существует ли уже пользователь с таким userId
    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ message: 'UserId is already in use' });
    }

    // Проверяем, существует ли пользователь с таким именем
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ message: 'Username is already taken' });
    }

    // Создаём нового пользователя с уникальным токеном
    const token = uuidv4();
    const newUser = new User({ username, userId, token });
    await newUser.save();

    res.json({ token });
  } catch (err) {
    console.error('Error during registration:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Запуск сервера
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});