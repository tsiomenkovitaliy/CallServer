const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const pairs = {};

// Когда клиент подключается
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

// Если нет существующих пар, добавляем клиента в ожидание
    if (Object.keys(pairs).length === 0) {
        pairs[socket.id] = null; // Ждём второго клиента
    } else {
        // Создаём пару с первым свободным клиентом
        const existingClientId = Object.keys(pairs).find((id) => pairs[id] === null);

        if (existingClientId) {
            pairs[existingClientId] = socket.id; // Связываем клиентов
            pairs[socket.id] = existingClientId;

            console.log(`Pair created: ${existingClientId} <-> ${socket.id}`);
        } else {
            pairs[socket.id] = null; // Нет доступных клиентов, ждём
        }
    }

        // Обработка начала звонка
    socket.on('start-call', ({ callUUID, targetUserId, callerName }) => {
        const targetId = pairs[socket.id];
        if (targetId) {
            
            console.log(`Call initiated: ${callUUID} from ${socket.id} to ${targetId}`);

            // Отправляем уведомление другому клиенту
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

    // // Клиент A начинает вызов
    // socket.on('start-call', ({ callUUID, targetUserId, callerName }) => {
    //     const targetSocketId = Object.keys(users).find(id => id !== socket.id);
    //     // const targetSocketId = users[0]
    //     // const targetSocketId = users[targetUserId]; // Ищем сокет клиента B
    //     if (targetSocketId) {
    //         // Отправляем клиенту B уведомление о входящем звонке
    //         io.to(targetSocketId).emit('incoming-call', {
    //             callUUID,
    //             callerName,
    //         });
    //         console.log(`Call initiated: ${callUUID} from ${callerName} to ${targetUserId}`);
    //     } else {
    //         console.log(`User ${targetUserId} is not online.`);
    //         socket.emit('call-error', { message: `User ${targetUserId} is not online.` });
    //     }
    // });

    socket.on('end-call', ({ callUUID }) => {
        const targetSocketId = pairs[socket.id]; // Находим второго клиента в паре

        if (targetSocketId) {
            io.to(targetSocketId).emit('call-ended', { callUUID });
            console.log(`Call ended: ${callUUID} between ${socket.id} and ${targetSocketId}`);
        } else {
            console.error(`No pair found for: ${socket.id}`);
        }
    });

    socket.on('signal', (data) => {

        const prettyJson = JSON.stringify(data, null, 2);
  
        console.log("Got signal event (pretty printed):\n", prettyJson);

        const targetSocketId = pairs[socket.id];
        if (targetSocketId) {
            const signalData = {
                senderId: socket.id,
                signal: {
                    senderId: socket.id,
                    signal: data.signal || null,
                    candidate: data.candidate || null
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
        const targetId = pairs[socket.id];
        if (targetId) {
            // Убираем связь
            pairs[targetId] = null;
            console.log(`User ${targetId} is now free`);
        }
        delete pairs[socket.id];
        console.log('User disconnected:', socket.id);
    });
});

server.listen(3000, () => {
    console.log('Server is running on port 3000');
});