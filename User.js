// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  token: { type: String, unique: true, required: true },
  socketId: { type: String, default: null },
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  pairedWith: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

module.exports = mongoose.model('User', UserSchema);