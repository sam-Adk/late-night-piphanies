const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'lne_jwt_secret_2026';
const PORT = process.env.PORT || 10000;

// ── SCHEMAS ──
const userSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  avatar:    { type: Number, default: 1 },
  phone:     { type: String, default: '' },
  addresses: [{ label: String, zone: String, area: String, street: String, notes: String, isDefault: Boolean }],
  wishlist:  [{ productId: String, title: String, img: String, price: Number, addedAt: { type: Date, default: Date.now } }],
  bids:      [{ productId: String, title: String, amount: Number, listedPrice: Number, placedAt: { type: Date, default: Date.now } }],
  created_at:{ type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  reference: { type: String, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  email: String, phone: String, amount: Number,
  currency: String, status: String, paid_at: String,
  channel: String, items: String,
  delivery: { zone: String, area: String, street: String, notes: String, fee: Number },
  created_at: { type: Date, default: Date.now }
});

const stockSchema = new mongoose.Schema({
  productId: { type: String, unique: true },
  sold:      { type: Number, default: 0 },
  maxPrints: { type: Number, default: 10 }
});

const User  = mongoose.model('User',  userSchema);
const Order = mongoose.model('Order', orderSchema);
const Stock = mongoose.model('Stock', stockSchema);

// ── MONGODB ──
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: 'late-night-epiphanies',
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      family: 4,
    });
    console.log('✅ Connected to MongoDB!');
    const products = Array.from({ length: 39 }, (_, i) => `p${i + 1}`);
    for (const productId of products) {
      await Stock.updateOne({ productId }, { $setOnInsert: { productId, sold: 0, maxPrints: 10 } }, { upsert: true });
    }
    console.log('✅ Stock ready!');
  } catch (err) {
    console.error('❌ MongoDB failed:', err.message);
    setTimeout(connectDB, 5000);
  }
}
connectDB();

// ── AUTH MIDDLEWARE ──
function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) req.user = jwt.verify(token, JWT_SECRET);
  } catch {}
  next();
}

// ================================================================
// API ROUTES — must be before express.static
// ================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

app.post('/api/auth/register', async (req, res) => {
  console.log('📝 Register:', req.body?.email);
  try {
    const { name, email, password, phone, avatar } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name: name.trim(), email: email.toLowerCase().trim(), password: hashed, phone: phone||'', avatar: avatar||1 });
    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✅ User created:', user.email);
    return res.status(201).json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, avatar: user.avatar, phone: user.phone, addresses: [] } });
  } catch (err) {
    console.error('❌ Register error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  console.log('🔑 Login:', req.body?.email);
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'No account found with this email' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✅ Login:', user.email);
    return res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, avatar: user.avatar, phone: user.phone, addresses: user.addresses } });
  } catch (err) {
    console.error('❌ Login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, avatar } = req.body;
    const update = {};
    if (name) update.name = name;
    if (phone !== undefined) update.phone = phone;
    if (avatar) update.avatar = avatar;
    const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/addresses', authMiddleware, async (req, res) => {
  try {
    const { label, zone, area, street, notes, isDefault } = req.body;
    if (!zone || !area) return res.status(400).json({ error: 'Zone and area required' });
    const user = await User.findById(req.user.id);
    if (isDefault) user.addresses.forEach(a => a.isDefault = false);
    user.addresses.push({ label: label||'Home', zone, area, street: street||'', notes: notes||'', isDefault: isDefault || user.addresses.length === 0 });
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/user/addresses/:index', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.addresses.splice(parseInt(req.params.index), 1);
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/wishlist', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('wishlist');
    res.json({ success: true, wishlist: user.wishlist });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/wishlist', authMiddleware, async (req, res) => {
  try {
    const { productId, title, img, price } = req.body;
    const user = await User.findById(req.user.id);
    const exists = user.wishlist.find(w => w.productId === productId);
    if (exists) { user.wishlist = user.wishlist.filter(w => w.productId !== productId); }
    else { user.wishlist.push({ productId, title, img, price }); }
    await user.save();
    res.json({ success: true, wishlist: user.wishlist, added: !exists });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/bids', authMiddleware, async (req, res) => {
  try {
    const { productId, title, amount, listedPrice } = req.body;
    const user = await User.findById(req.user.id);
    user.bids.unshift({ productId, title, amount, listedPrice });
    await user.save();
    res.json({ success: true, bids: user.bids });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/orders', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ $or: [{ userId: req.user.id }, { email: req.user.email }] }).sort({ created_at: -1 });
    res.json({ success: true, orders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const deliveryZones = {
  'CBD & Westlands': { fee: 200, areas: ['CBD','Westlands','Parklands','Upperhill','Kilimani','Lavington','Hurlingham','Ngara'] },
  'Eastlands':       { fee: 300, areas: ['Umoja','Kayole','Embakasi','Donholm','Komarock','Fedha','Buruburu','Pipeline','Utawala'] },
  'Southlands':      { fee: 350, areas: ["Lang'ata",'Karen','Ngong Road','South B','South C','Nairobi West','Rongai','Athi River'] },
  'Northlands':      { fee: 300, areas: ['Kasarani','Ruiru','Thika Road','Roysambu','Kahawa','Githurai','Zimmerman','Clay City'] },
  'Satellite Towns': { fee: 500, areas: ['Kikuyu','Limuru','Machakos','Kitengela','Ongata Rongai','Ngong Town','Thika Town','Juja'] }
};
app.get('/api/delivery/zones', (req, res) => res.json({ success: true, zones: deliveryZones }));

app.post('/api/paystack/verify', optionalAuth, async (req, res) => {
  const { reference, delivery, items, phone } = req.body;
  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
    const data = response.data.data;
    if (data.status === 'success') {
      try {
        await Order.findOneAndUpdate(
          { reference: data.reference },
          { reference: data.reference, userId: req.user?.id||null, email: data.customer.email, phone: phone||'', amount: data.amount/100, currency: data.currency, status: 'paid', paid_at: data.paid_at, channel: data.channel, items: items||'', delivery: delivery||{} },
          { upsert: true, new: true }
        );
      } catch (dbErr) { console.error('DB save error:', dbErr.message); }
      res.json({ success: true, amount: data.amount/100, email: data.customer.email, reference: data.reference });
    } else { res.json({ success: false, status: data.status }); }
  } catch (err) { res.status(500).json({ error: 'Verification failed' }); }
});

app.post('/api/paystack/webhook', async (req, res) => {
  const event = req.body;
  if (event.event === 'charge.success') {
    try {
      await Order.findOneAndUpdate({ reference: event.data.reference }, { reference: event.data.reference, email: event.data.customer.email, amount: event.data.amount/100, status: 'paid', paid_at: event.data.paid_at, channel: event.data.channel }, { upsert: true, new: true });
    } catch (err) { console.error('Webhook error:', err.message); }
  }
  res.sendStatus(200);
});

app.get('/api/stock', async (req, res) => {
  try { res.json({ success: true, stock: await Stock.find({}) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders', async (req, res) => {
  try { res.json({ success: true, orders: await Order.find({}).sort({ created_at: -1 }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
// STATIC FILES — after all API routes
// ================================================================
app.use(express.static(ROOT));
app.get('/',          (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/about',     (req, res) => res.sendFile(path.join(ROOT, 'about.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/auth',      (req, res) => res.sendFile(path.join(ROOT, 'auth.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(ROOT, 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Root: ${ROOT}`);
});
