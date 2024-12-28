// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const User = require('./User'); // Убедитесь, что путь к модели верный

// Подключение к MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/chatApp')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Настройка Express
const app = express();
app.use(express.json());

// Маршрут для регистрации пользователя
app.post('/register', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ message: 'Необходимо указать имя пользователя' });
    }

    // Проверяем, существует ли уже пользователь с таким именем
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Пользователь с таким именем уже существует' });
    }

    // Генерируем уникальный токен
    const token = uuidv4();

    // Создаём и сохраняем пользователя в базе
    const newUser = new User({
      username,
      token
    });
    await newUser.save();

    // Возвращаем токен
    return res.json({
      message: 'Пользователь успешно зарегистрирован',
      token
    });
  } catch (error) {
    console.error('Ошибка при регистрации пользователя:', error);
    return res.status(500).json({ message: 'Внутренняя ошибка сервера' });
  }
});

// Создаём HTTP-сервер и Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*' // Настройте CORS по необходимости
  }
});

// Храним информацию о том, кто сейчас в сети
const onlineUsers = {};

// Храним пары: pairs[idA] = idB и pairs[idB] = idA
const pairs = {};

// Мидлвэра для аутентификации Socket.IO
io.use(async (socket, next) => {
  try {
    // Получаем токен из аутентификации сокета
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      return next(new Error('Ошибка аутентификации: отсутствует токен'));
    }

    // Ищем пользователя в базе
    const user = await User.findOne({ token });
    if (!user) {
      return next(new Error('Невалидный токен'));
    }

    // Привязываем пользователя к сокету
    socket.user = user;
    next();
  } catch (err) {
    console.error('Ошибка в мидлвэре Socket.IO:', err);
    return next(new Error('Внутренняя ошибка сервера'));
  }
});

// Обработчик событий подключения
io.on('connection', async (socket) => {
  try {
    const user = socket.user;

    // Обновляем статус и socketId пользователя
    user.status = 'online';
    user.socketId = socket.id;
    await user.save();

    // Добавляем пользователя в onlineUsers
    onlineUsers[socket.id] = user._id.toString();

    console.log(`Пользователь ${user.username} подключился, socketId: ${socket.id}`);

    // Попытка найти свободного пользователя, чтобы сразу объединить в пару
    const existingClient = await User.findOne({ pairedWith: null, status: 'online', _id: { $ne: user._id } });

    if (!existingClient) {
      // Нет свободного пользователя, ждем второго
      user.pairedWith = null;
      await user.save();
      pairs[user._id.toString()] = null;
      console.log(`Пользователь ${user.username} ждет пару`);
    } else {
      // Создаем пару
      user.pairedWith = existingClient._id;
      existingClient.pairedWith = user._id;
      await user.save();
      await existingClient.save();

      pairs[user._id.toString()] = existingClient._id.toString();
      pairs[existingClient._id.toString()] = user._id.toString();

      console.log(`Пара создана: ${existingClient.username} <-> ${user.username}`);

      // Уведомляем обоих пользователей о создании пары
      socket.emit('pair-found', { pairedWith: existingClient.username, pairedWithId: existingClient._id });
      const existingSocket = io.sockets.sockets.get(existingClient.socketId);
      if (existingSocket) {
        existingSocket.emit('pair-found', { pairedWith: user.username, pairedWithId: user._id });
      }
    }

    // Отправляем текущему пользователю список всех других пользователей
    const otherUsers = await User.find({ _id: { $ne: user._id } }, 'username status');
    socket.emit('user-list', otherUsers);

    // Уведомляем других пользователей о новом подключении
    socket.broadcast.emit('user-connected', {
      username: user.username,
      status: user.status
    });

    // Обработка начала звонка
    socket.on('start-call', async ({ callUUID, targetUserId, callerName }) => {
      const targetUser = await User.findById(targetUserId);
      if (targetUser && targetUser.status === 'online' && targetUser.socketId) {
        console.log(`Call initiated: ${callUUID} from ${user.username} to ${targetUser.username}`);

        // Отправляем уведомление второму клиенту
        io.to(targetUser.socketId).emit('incoming-call', {
          callUUID,
          callerName,
        });

        // Уведомляем инициатора, что звонок начат
        socket.emit('call-initiated', {
          callUUID,
          targetId: targetUser._id
        });
      } else {
        console.error(`No pair found or target user is offline for: ${user.username}`);
        socket.emit('call-error', { message: 'No pair available for the call.' });
      }
    });

    // Завершение звонка
    socket.on('end-call', async ({ callUUID }) => {
      const targetUserId = pairs[user._id.toString()];
      if (targetUserId) {
        const targetUser = await User.findById(targetUserId);
        if (targetUser && targetUser.socketId) {
          io.to(targetUser.socketId).emit('call-ended', { callUUID });
          console.log(`Call ended: ${callUUID} between ${user.username} and ${targetUser.username}`);
        } else {
          console.error(`Target user not found or offline for: ${user.username}`);
        }
      } else {
        console.error(`No pair found for: ${user.username}`);
      }
    });

    // Обработка сигналов WebRTC
    socket.on('signal', async (data) => {
      const targetUserId = pairs[user._id.toString()];
      if (targetUserId) {
        const targetUser = await User.findById(targetUserId);
        if (targetUser && targetUser.socketId) {
          const signalData = {
            senderId: user._id,
            signal: data.signal || null,
            candidate: data.candidate || null,
          };
          io.to(targetUser.socketId).emit('signal', signalData);
          console.log(`Signal sent from ${user.username} to ${targetUser.username}`);
        } else {
          console.error(`Target user not found or offline for signal from: ${user.username}`);
        }
      } else {
        console.error(`No pair found for signal from: ${user.username}`);
      }
    });

    // Обработка события reconnect (опционально, можно использовать встроенные события Socket.IO)
    socket.on('reconnect', () => {
      console.log(`Reconnect sent from ${socket.id}`);
    });

    // Обработка отключения клиента
    socket.on('disconnect', async () => {
      console.log(`Пользователь ${user.username} отключился, socketId: ${socket.id}`);

      // Удаляем пользователя из onlineUsers
      delete onlineUsers[socket.id];

      // Освобождаем второго пользователя из пары (если был связан)
      const targetUserId = pairs[user._id.toString()];
      if (targetUserId) {
        const targetUser = await User.findById(targetUserId);
        if (targetUser && targetUser.status === 'online') {
          // Ставим целевого пользователя в свободное состояние
          targetUser.pairedWith = null;
          await targetUser.save();
          pairs[targetUserId] = null;
          console.log(`Пользователь ${targetUser.username} освобожден и может искать новую пару`);

          // Уведомляем целевого пользователя о разрыве пары
          const targetSocket = io.sockets.sockets.get(targetUser.socketId);
          if (targetSocket) {
            targetSocket.emit('pair-disconnected', { message: 'Ваш партнер отключился.' });
          }
        } else {
          // Если второй пользователь офлайн, просто удаляем его из pairs
          delete pairs[targetUserId];
        }
      }

      // Убираем самого отключившегося из объекта pairs
      delete pairs[user._id.toString()];

      // Обновляем статус пользователя
      user.status = 'offline';
      user.socketId = null;
      user.pairedWith = null;
      await user.save();

      // Уведомляем других пользователей об отключении
      socket.broadcast.emit('user-disconnected', {
        username: user.username,
        status: user.status
      });
    });
  } catch (error) {
    console.error('Ошибка при обработке подключения:', error);
  }
});

// Запуск сервера
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});