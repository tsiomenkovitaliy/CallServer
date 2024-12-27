const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Храним информацию о том, кто сейчас в сети
// ключ: socket.id, значение: true (или любая другая информация)
const onlineUsers = {};

// Храним пары: pairs[idA] = idB и pairs[idB] = idA
const pairs = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Отмечаем пользователя как онлайн
    onlineUsers[socket.id] = true;

    // Попытка найти свободного пользователя, чтобы сразу объединить в пару
    const existingClientId = Object.keys(pairs).find((id) => pairs[id] === null);

    if (!existingClientId) {
        // Нет свободного пользователя, ждем второго
        pairs[socket.id] = null;
        console.log(`User ${socket.id} ждет пару`);
    } else {
        // Перед созданием пары проверяем, онлайн ли ещё existingClientId
        // (Вдруг он успел отключиться, но по каким-то причинам ещё остался в pairs)
        if (onlineUsers[existingClientId]) {
            // Создаем пару
            pairs[existingClientId] = socket.id;
            pairs[socket.id] = existingClientId;
            console.log(`Pair created: ${existingClientId} <-> ${socket.id}`);
        } else {
            // Если тот пользователь уже офлайн, убираем его из pairs
            delete pairs[existingClientId];
            // И ставим текущего в режим ожидания
            pairs[socket.id] = null;
            console.log(`Пользователь ${existingClientId} оказался офлайн`);
            console.log(`User ${socket.id} ждет пару`);
        }
    }

    // Обработка начала звонка
    socket.on('start-call', ({ callUUID, targetUserId, callerName }) => {
        const targetId = pairs[socket.id];
        if (targetId) {
            console.log(`Call initiated: ${callUUID} from ${socket.id} to ${targetId}`);

            // Отправляем уведомление второму клиенту
            io.to(targetId).emit('incoming-call', {
                callUUID,
                callerName,
            });

            // Уведомляем инициатора, что звонок начат
            socket.emit('call-initiated', {
                callUUID,
                targetId,
            });
        } else {
            console.error(`No pair found for: ${socket.id}`);
            socket.emit('call-error', { message: 'No pair available for the call.' });
        }
    });

    // Завершение звонка
    socket.on('end-call', ({ callUUID }) => {
        const targetSocketId = pairs[socket.id];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-ended', { callUUID });
            console.log(`Call ended: ${callUUID} between ${socket.id} and ${targetSocketId}`);
        } else {
            console.error(`No pair found for: ${socket.id}`);
        }
    });

    // Обработка сигналов WebRTC
    socket.on('signal', (data) => {
        const prettyJson = JSON.stringify(data, null, 2);

        const targetSocketId = pairs[socket.id];
        if (targetSocketId) {
            const signalData = {
                senderId: socket.id,
                signal: {
                    senderId: socket.id,
                    signal: data.signal || null,
                    candidate: data.candidate || null,
                }
            };
            io.to(targetSocketId).emit('signal', signalData);
            console.log(`Signal sent from ${socket.id} to ${targetSocketId}`);
        } else {
            console.error(`No pair found for: ${socket.id}`);
        }
    });

    // Обработка отключения клиента
    socket.on('disconnect', () => {
        // Удаляем пользователя из онлайн списка
        delete onlineUsers[socket.id];

        // Освобождаем второго пользователя из пары (если был связан)
        const targetId = pairs[socket.id];
        if (targetId) {
            // Если второй пользователь ещё онлайн, ставим его в null,
            // чтобы он вновь мог найти пару
            if (onlineUsers[targetId]) {
                pairs[targetId] = null;
                console.log(`User ${targetId} is now free`);
            } else {
                // Если второй пользователь тоже офлайн – просто удаляем его
                delete pairs[targetId];
            }
        }

        // Убираем самого отключившегося из объекта pairs
        delete pairs[socket.id];
        
        console.log('User disconnected:', socket.id);
    });
});

server.listen(3000, () => {
    console.log('Server is running on port 3000');
});
