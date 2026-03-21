import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.join(__dirname, '..');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const {
  PAYSTACK_SECRET_KEY,
  MONGODB_URI,
  JWT_SECRET = 'lne_jwt_secret_2026',
  PORT = 10000
} = process.env;

console.log('🔑 JWT_SECRET set:', !!JWT_SECRET);
console.log('🔑 MONGODB_URI set:', !!MONGODB_URI);
console.log('🔑 PAYSTACK_SECRET_KEY set:', !!PAYSTACK_SECRET_KEY);

// ================================================================
// SCHEMAS
// ================================================================
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
  reference:  { type: String, unique: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  email:      String,
  phone:      String,
  amount:     Number,
  currency:   String,
  status:     String,
  paid_at:    String,
  channel:    String,
  items:      String,
  delivery:   { zone: String, area: String, street: String, notes: String, fee: Number },
  created_at: { type: Date, default: Date.now }
});

const stockSchema = new mongoose.Schema({
  productId:  { type: String, unique: true },
  sold:       { type: Number, default: 0 },
  maxPrints:  { type: Number, default: 10 }
});

const User  = mongoose.model('User',  userSchema);
const Order = mongoose.model('Order', orderSchema);
const Stock = mongoose.model('Stock', stockSchema);

// ================================================================
// MONGODB
// ================================================================
let dbConnected = false;

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
    dbConnected = true;
    console.log('✅ Connected to MongoDB!');
    const products = Array.from({ length: 39 }, (_, i) => `p${i + 1}`);
    for (const productId of products) {
      await Stock.updateOne({ productId }, { $setOnInsert: { productId, sold: 0, maxPrints: 10 } }, { upsert: true });
    }
    console.log('✅ Stock ready!');
  } catch (err) {
    dbConnected = false;
    console.error('❌ MongoDB failed:', err.message);
    setTimeout(connectDB, 5000);
  }
}
connectDB();

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
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
// DB CHECK MIDDLEWARE
// ================================================================
function requireDB(req, res, next) {
  if (!dbConnected || mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database not connected. Please try again in a moment.' });
  }
  next();
}

// ================================================================
// STATIC FILES
// ================================================================
app.use(express.static(ROOT));
app.get('/',          (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/about',     (req, res) => res.sendFile(path.join(ROOT, 'about.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/auth',      (req, res) => res.sendFile(path.join(ROOT, 'auth.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(ROOT, 'dashboard.html')));

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    db: dbConnected ? 'connected' : 'disconnected',
    dbState: mongoose.connection.readyState,
    time: new Date().toISOString()
  });
});

// ================================================================
// AUTH: REGISTER
// ================================================================
app.post('/api/auth/register', requireDB, async (req, res) => {
  console.log('📝 Register attempt:', req.body?.email);
  try {
    const { name, email, password, phone, avatar } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email exists
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password
    console.log('🔐 Hashing password...');
    const hashed = await bcrypt.hash(password, 10);
    console.log('✅ Password hashed');

    // Create user
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashed,
      phone: phone || '',
      avatar: avatar || 1
    });
    console.log('✅ User created:', user._id);

    // Generate token
    const token = jwt.sign(
      { id: user._id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        phone: user.phone,
        addresses: user.addresses
      }
    });
  } catch (err) {
    console.error('❌ Register error:', err.message, err.stack);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// ================================================================
// AUTH: LOGIN
// ================================================================
app.post('/api/auth/login', requireDB, async (req, res) => {
  console.log('🔑 Login attempt:', req.body?.email);
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ error: 'No account found with this email' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    console.log('✅ Login successful:', user.email);
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        phone: user.phone,
        addresses: user.addresses
      }
    });
  } catch (err) {
    console.error('❌ Login error:', err.message);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// ================================================================
// AUTH: GET ME
// ================================================================
app.get('/api/auth/me', authMiddleware, requireDB, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER: UPDATE PROFILE
// ================================================================
app.put('/api/user/profile', authMiddleware, requireDB, async (req, res) => {
  try {
    const { name, phone, avatar } = req.body;
    const update = {};
    if (name)             update.name   = name;
    if (phone !== undefined) update.phone = phone;
    if (avatar)           update.avatar = avatar;
    const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER: ADDRESSES
// ================================================================
app.post('/api/user/addresses', authMiddleware, requireDB, async (req, res) => {
  try {
    const { label, zone, area, street, notes, isDefault } = req.body;
    if (!zone || !area) return res.status(400).json({ error: 'Zone and area are required' });
    const user = await User.findById(req.user.id);
    if (isDefault) user.addresses.forEach(a => a.isDefault = false);
    user.addresses.push({ label: label || 'Home', zone, area, street: street||'', notes: notes||'', isDefault: isDefault || user.addresses.length === 0 });
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/user/addresses/:index', authMiddleware, requireDB, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.addresses.splice(parseInt(req.params.index), 1);
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER: WISHLIST
// ================================================================
app.get('/api/user/wishlist', authMiddleware, requireDB, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('wishlist');
    res.json({ success: true, wishlist: user.wishlist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/wishlist', authMiddleware, requireDB, async (req, res) => {
  try {
    const { productId, title, img, price } = req.body;
    const user = await User.findById(req.user.id);
    const exists = user.wishlist.find(w => w.productId === productId);
    if (exists) {
      user.wishlist = user.wishlist.filter(w => w.productId !== productId);
    } else {
      user.wishlist.push({ productId, title, img, price });
    }
    await user.save();
    res.json({ success: true, wishlist: user.wishlist, added: !exists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER: BIDS
// ================================================================
app.post('/api/user/bids', authMiddleware, requireDB, async (req, res) => {
  try {
    const { productId, title, amount, listedPrice } = req.body;
    const user = await User.findById(req.user.id);
    user.bids.unshift({ productId, title, amount, listedPrice });
    await user.save();
    res.json({ success: true, bids: user.bids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER: MY ORDERS
// ================================================================
app.get('/api/user/orders', authMiddleware, requireDB, async (req, res) => {
  try {
    const orders = await Order.find({
      $or: [{ userId: req.user.id }, { email: req.user.email }]
    }).sort({ created_at: -1 });
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// DELIVERY ZONES
// ================================================================
const deliveryZones = {
  'CBD & Westlands': { fee: 200, areas: ['CBD','Westlands','Parklands','Upperhill','Kilimani','Lavington','Hurlingham','Ngara','Pangani'] },
  'Eastlands':       { fee: 300, areas: ['Umoja','Kayole','Embakasi','Donholm','Komarock','Tena','Fedha','Buruburu','Pipeline','Utawala','Ruai'] },
  'Southlands':      { fee: 350, areas: ["Lang'ata",'Karen','Ngong Road','South B','South C','Nairobi West','Rongai','Athi River'] },
  'Northlands':      { fee: 300, areas: ['Kasarani','Ruiru','Thika Road','Roysambu','Garden Estate','Kahawa','Githurai','Zimmerman','Clay City','Mwiki'] },
  'Satellite Towns': { fee: 500, areas: ['Kikuyu','Limuru','Machakos','Kitengela','Ongata Rongai','Ngong Town','Thika Town','Juja'] }
};

app.get('/api/delivery/zones', (req, res) => {
  res.json({ success: true, zones: deliveryZones });
});

// ================================================================
// PAYSTACK: Verify + Save Order
// ================================================================
app.post('/api/paystack/verify', optionalAuth, requireDB, async (req, res) => {
  const { reference, delivery, items, phone } = req.body;
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = response.data.data;
    if (data.status === 'success') {
      try {
        await Order.findOneAndUpdate(
          { reference: data.reference },
          {
            reference: data.reference,
            userId:    req.user?.id || null,
            email:     data.customer.email,
            phone:     phone || '',
            amount:    data.amount / 100,
            currency:  data.currency,
            status:    'paid',
            paid_at:   data.paid_at,
            channel:   data.channel,
            items:     items || '',
            delivery:  delivery || {}
          },
          { upsert: true, new: true }
        );
        console.log(`✅ Order saved: ${data.reference}`);
      } catch (dbErr) { console.error('DB save error:', dbErr.message); }
      res.json({ success: true, amount: data.amount / 100, email: data.customer.email, reference: data.reference });
    } else {
      res.json({ success: false, status: data.status });
    }
  } catch (err) {
    console.error('Verify error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ================================================================
// PAYSTACK: Webhook
// ================================================================
app.post('/api/paystack/webhook', async (req, res) => {
  const event = req.body;
  if (event.event === 'charge.success') {
    const data = event.data;
    try {
      await Order.findOneAndUpdate(
        { reference: data.reference },
        { reference: data.reference, email: data.customer.email, amount: data.amount / 100, currency: data.currency, status: 'paid', paid_at: data.paid_at, channel: data.channel },
        { upsert: true, new: true }
      );
      console.log(`✅ Webhook saved: ${data.reference}`);
    } catch (err) { console.error('Webhook DB error:', err.message); }
  }
  res.sendStatus(200);
});

// ================================================================
// STOCK API
// ================================================================
app.get('/api/stock', async (req, res) => {
  try {
    const stock = await Stock.find({});
    res.json({ success: true, stock });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
// ORDERS API (admin)
// ================================================================
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ created_at: -1 });
    res.json({ success: true, count: orders.length, orders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Serving files from: ${ROOT}`);
});
