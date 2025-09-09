// server.js - Express + Socket.IO comment & reaction demo
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DB_PATH = path.join(__dirname, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_demo_key';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB helpers
async function loadDB() {
  try {
    if (!(await fs.pathExists(DB_PATH))) {
      await fs.writeJson(DB_PATH, { users: [], comments: [], nextCommentId: 1, nextUserId: 1 }, { spaces: 2 });
    }
    return fs.readJson(DB_PATH);
  } catch (err) {
    console.error('loadDB error', err);
    throw err;
  }
}
async function saveDB(db) {
  await fs.writeJson(DB_PATH, db, { spaces: 2 });
}

// Auth helpers
function generateToken(user) {
  const payload = { id: user.id, name: user.name, email: user.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ message: 'Missing authorization header' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ message: 'Invalid authorization header' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// Utilities
function buildCommentsTree(comments) {
  const map = {};
  comments.forEach(c => { map[c.id] = { ...c, replies: [] }; });
  const roots = [];
  comments.forEach(c => {
    if (c.parentId == null) roots.push(map[c.id]);
    else if (map[c.parentId]) map[c.parentId].replies.push(map[c.id]);
  });
  const sortFn = (a,b) => new Date(b.createdAt) - new Date(a.createdAt);
  roots.sort(sortFn);
  return roots;
}

// Routes
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'name, email, password required' });
  const db = await loadDB();
  const exists = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (exists) return res.status(400).json({ message: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: db.nextUserId++,
    name,
    email,
    passwordHash,
    avatar: `https://i.pravatar.cc/48?u=${encodeURIComponent(email)}`
  };
  db.users.push(newUser);
  await saveDB(db);
  const token = generateToken(newUser);
  res.json({ user: { id: newUser.id, name: newUser.name, email: newUser.email, avatar: newUser.avatar }, token });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'email and password required' });
  const db = await loadDB();
  const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(400).json({ message: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ message: 'Invalid credentials' });
  const token = generateToken(user);
  res.json({ user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar }, token });
});

app.get('/api/comments', async (req, res) => {
  const db = await loadDB();
  res.json({ comments: buildCommentsTree(db.comments) });
});

app.post('/api/comments', authMiddleware, async (req, res) => {
  const { content, parentId = null } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ message: 'Empty content' });
  const db = await loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(401).json({ message: 'User not found' });

  const newComment = {
    id: db.nextCommentId++,
    userId: user.id,
    userName: user.name,
    avatar: user.avatar,
    content: content.trim(),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    parentId: parentId || null,
    reactions: { like: [], love: [], haha: [], wow: [], sad: [], angry: [] }
  };

  db.comments.push(newComment);
  await saveDB(db);
  io.emit('comments:update', { comments: buildCommentsTree(db.comments) });
  res.status(201).json({ comment: newComment });
});

app.put('/api/comments/:id', authMiddleware, async (req, res) => {
  const commentId = parseInt(req.params.id, 10);
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ message: 'Empty content' });
  const db = await loadDB();
  const comment = db.comments.find(c => c.id === commentId);
  if (!comment) return res.status(404).json({ message: 'Comment not found' });
  if (comment.userId !== req.user.id) return res.status(403).json({ message: 'Not allowed' });

  comment.content = content.trim();
  comment.updatedAt = new Date().toISOString();
  await saveDB(db);
  io.emit('comments:update', { comments: buildCommentsTree(db.comments) });
  res.json({ comment });
});

app.delete('/api/comments/:id', authMiddleware, async (req, res) => {
  const commentId = parseInt(req.params.id, 10);
  const db = await loadDB();
  const comment = db.comments.find(c => c.id === commentId);
  if (!comment) return res.status(404).json({ message: 'Comment not found' });
  if (comment.userId !== req.user.id) return res.status(403).json({ message: 'Not allowed' });

  const toRemove = new Set();
  function markDescendants(id) {
    toRemove.add(Number(id));
    db.comments.filter(c => c.parentId === id).forEach(child => markDescendants(child.id));
  }
  markDescendants(commentId);
  db.comments = db.comments.filter(c => !toRemove.has(c.id));
  await saveDB(db);
  io.emit('comments:update', { comments: buildCommentsTree(db.comments) });
  res.json({ message: 'Deleted' });
});

app.post('/api/reactions', authMiddleware, async (req, res) => {
  const { commentId, reaction } = req.body;
  const valid = ['like', 'love', 'haha', 'wow', 'sad', 'angry'];
  if (!valid.includes(reaction)) return res.status(400).json({ message: 'Invalid reaction' });
  const db = await loadDB();
  const comment = db.comments.find(c => c.id === Number(commentId));
  if (!comment) return res.status(404).json({ message: 'Comment not found' });

  const userId = req.user.id;
  const arr = comment.reactions[reaction];
  const idx = arr.indexOf(userId);
  if (idx === -1) arr.push(userId);
  else arr.splice(idx, 1);

  await saveDB(db);
  io.emit('comments:update', { comments: buildCommentsTree(db.comments) });
  res.json({ reactions: comment.reactions });
});

// Serve app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

// Start
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
