const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'lne_jwt_secret_2026';
const PORT = process.env.PORT || 10000;

// The HTML files are in the parent folder (repo root)
const ROOT = path.resolve(__dirname, '..');
console.log('ROOT:', ROOT);

// ── SCHEMAS ──
const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  avatar:    { type: Number, default: 1 },
  phone:     { type: String, default: '' },
  addresses: [{ label: String, zone: String, area: String, street: String, notes: String, isDefault: Boolean }],
  wishlist:  [{ productId: String, title: String, img: String, price: Number }],
  bids:      [{ productId: String, title: String, amount: Number, listedPrice: Number }],
  created_at:{ type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  reference: { type: String, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, default: null },
  email: String, phone: String, amount: Number,
  currency: String, status: String, paid_at: String,
  channel: String, items: String,
  delivery: { zone: String, area: String, street: String, fee: Number },
  created_at: { type: Date, default: Date.now }
});

const stockSchema = new mongoose.Schema({
  productId: { type: String, unique: true },
  sold: { type: Number, default: 0 },
  maxPrints: { type: Number, default: 10 }
});

const User  = mongoose.model('User', userSchema);
const Order = mongoose.model('Order', orderSchema);
const Stock = mongoose.model('Stock', stockSchema);

// ── MONGODB ──
mongoose.connect(MONGODB_URI, {
  dbName: 'late-night-epiphanies',
  tls: true,
  tlsAllowInvalidCertificates: true,
  tlsAllowInvalidHostnames: true,
  serverSelectionTimeoutMS: 30000,
  family: 4
}).then(async () => {
  console.log('✅ MongoDB connected!');
  const ids = Array.from({ length: 39 }, (_, i) => `p${i+1}`);
  for (const productId of ids) {
    await Stock.updateOne({ productId }, { $setOnInsert: { productId, sold: 0, maxPrints: 10 } }, { upsert: true });
  }
  console.log('✅ Stock ready!');
}).catch(err => {
  console.error('❌ MongoDB error:', err.message);
  setTimeout(() => mongoose.connect(MONGODB_URI), 5000);
});

// ── AUTH MIDDLEWARE ──
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function optAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { if (token) req.user = jwt.verify(token, JWT_SECRET); } catch {}
  next();
}

// ================================================================
// API ROUTES
// ================================================================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState, time: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res) => {
  console.log('REGISTER HIT', req.body);
  try {
    const { name, email, password, phone, avatar } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email: email.toLowerCase(), password: hashed, phone: phone||'', avatar: avatar||1 });
    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✅ Registered:', user.email);
    res.status(201).json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, avatar: user.avatar, phone: user.phone, addresses: [] } });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  console.log('LOGIN HIT', req.body?.email);
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'No account found with this email' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    console.log('✅ Login:', user.email);
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, avatar: user.avatar, phone: user.phone, addresses: user.addresses } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/user/profile', auth, async (req, res) => {
  try {
    const { name, phone, avatar } = req.body;
    const u = {};
    if (name) u.name = name;
    if (phone !== undefined) u.phone = phone;
    if (avatar) u.avatar = avatar;
    const user = await User.findByIdAndUpdate(req.user.id, { $set: u }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/addresses', auth, async (req, res) => {
  try {
    const { label, zone, area, street, notes, isDefault } = req.body;
    if (!zone || !area) return res.status(400).json({ error: 'Zone and area required' });
    const user = await User.findById(req.user.id);
    if (isDefault) user.addresses.forEach(a => a.isDefault = false);
    user.addresses.push({ label: label||'Home', zone, area, street: street||'', notes: notes||'', isDefault: isDefault || !user.addresses.length });
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/user/addresses/:i', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.addresses.splice(+req.params.i, 1);
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/wishlist', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('wishlist');
    res.json({ success: true, wishlist: user.wishlist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/wishlist', auth, async (req, res) => {
  try {
    const { productId, title, img, price } = req.body;
    const user = await User.findById(req.user.id);
    const has = user.wishlist.find(w => w.productId === productId);
    if (has) user.wishlist = user.wishlist.filter(w => w.productId !== productId);
    else user.wishlist.push({ productId, title, img, price });
    await user.save();
    res.json({ success: true, wishlist: user.wishlist, added: !has });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/bids', auth, async (req, res) => {
  try {
    const { productId, title, amount, listedPrice } = req.body;
    const user = await User.findById(req.user.id);
    user.bids.unshift({ productId, title, amount, listedPrice });
    await user.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/orders', auth, async (req, res) => {
  try {
    const orders = await Order.find({ $or: [{ userId: req.user.id }, { email: req.user.email }] }).sort({ created_at: -1 });
    res.json({ success: true, orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const ZONES = {
  'CBD & Westlands': { fee: 200, areas: ['CBD','Westlands','Parklands','Upperhill','Kilimani','Lavington','Hurlingham'] },
  'Eastlands':       { fee: 300, areas: ['Umoja','Kayole','Embakasi','Donholm','Fedha','Buruburu','Pipeline','Utawala'] },
  'Southlands':      { fee: 350, areas: ["Lang'ata",'Karen','South B','South C','Nairobi West','Rongai','Athi River'] },
  'Northlands':      { fee: 300, areas: ['Kasarani','Ruiru','Thika Road','Roysambu','Kahawa','Githurai','Zimmerman'] },
  'Satellite Towns': { fee: 500, areas: ['Kikuyu','Limuru','Machakos','Kitengela','Ongata Rongai','Thika Town','Juja'] }
};
app.get('/api/delivery/zones', (req, res) => res.json({ success: true, zones: ZONES }));

app.post('/api/paystack/verify', optAuth, async (req, res) => {
  try {
    const { reference, delivery, items, phone } = req.body;
    const r = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
    const d = r.data.data;
    if (d.status === 'success') {
      await Order.findOneAndUpdate({ reference: d.reference }, { reference: d.reference, userId: req.user?.id||null, email: d.customer.email, phone: phone||'', amount: d.amount/100, currency: d.currency, status: 'paid', paid_at: d.paid_at, channel: d.channel, items: items||'', delivery: delivery||{} }, { upsert: true });
      res.json({ success: true, reference: d.reference });
    } else { res.json({ success: false }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paystack/webhook', async (req, res) => {
  if (req.body.event === 'charge.success') {
    const d = req.body.data;
    try { await Order.findOneAndUpdate({ reference: d.reference }, { reference: d.reference, email: d.customer.email, amount: d.amount/100, status: 'paid', channel: d.channel }, { upsert: true }); }
    catch (e) { console.error(e.message); }
  }
  res.sendStatus(200);
});

app.get('/api/stock', async (req, res) => {
  try { res.json({ success: true, stock: await Stock.find({}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', async (req, res) => {
  try { res.json({ success: true, orders: await Order.find({}).sort({ created_at: -1 }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// SERVE HTML FILES — after all API routes
// ================================================================
app.use(express.static(ROOT));
app.get('/',          (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/about',     (req, res) => res.sendFile(path.join(ROOT, 'about.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/auth',      (req, res) => res.sendFile(path.join(ROOT, 'auth.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(ROOT, 'dashboard.html')));

app.listen(PORT, () => console.log(`✅ Server on port ${PORT} | ROOT: ${ROOT}`));
