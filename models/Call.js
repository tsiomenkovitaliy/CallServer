// models/Call.js
const mongoose = require('mongoose');

const CallSchema = new mongoose.Schema({
  callUUID: {
    type: String,
    required: true,
    unique: true,
  },
  callerId: {        // Кто инициировал звонок
    type: String,
    required: true,
  },
  calleeId: {        // Кому звонят
    type: String,
    required: true,
  },
  // SDP offer/answer можно сохранять для "холодного" реконнекта,
  // если нужно поддерживать перезапуск соединения
  offerSdp: {
    type: String,
    default: null
  },
  answerSdp: {
    type: String,
    default: null
  },
  // Можно хранить ICE-кандидаты, если нужно
  // candidateList: [
  //   {
  //     sdp: String,
  //     sdpMLineIndex: Number,
  //     sdpMid: String,
  //   }
  // ],
  status: {
    type: String,
    enum: ['pending', 'active', 'ended'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// При каждом сохранении документа обновляем updatedAt
CallSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Call', CallSchema);