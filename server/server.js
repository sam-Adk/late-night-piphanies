import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.join(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json());

const { PAYSTACK_SECRET_KEY, MONGODB_URI, PORT = 10000 } = process.env;

// ================================================================
// MONGOOSE SCHEMAS
// ================================================================
const orderSchema = new mongoose.Schema({
  reference:  { type: String, unique: true },
  email:      String,
  amount:     Number,
  currency:   String,
  status:     String,
  paid_at:    String,
  channel:    String,
  items:      String,
  created_at: { type: Date, default: Date.now }
});

const stockSchema = new mongoose.Schema({
  productId: { type: String, unique: true },
  sold:      { type: Number, default: 0 },
  maxPrints: { type: Number, default: 10 }
});

const Order = mongoose.model('Order', orderSchema);
const Stock = mongoose.model('Stock', stockSchema);

// ================================================================
// MONGOOSE CONNECTION
// ================================================================
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: 'late-night-epiphanies',
      ssl: true,
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      family: 4, // Force IPv4 — fixes many Render SSL issues
    });
    console.log('✅ Connected to MongoDB!');

    // Initialize stock for all 39 products
    const products = Array.from({ length: 39 }, (_, i) => `p${i + 1}`);
    for (const productId of products) {
      await Stock.updateOne(
        { productId },
        { $setOnInsert: { productId, sold: 0, maxPrints: 10 } },
        { upsert: true }
      );
    }
    console.log('✅ Stock collection ready!');

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('🔄 Retrying in 5s...');
    setTimeout(connectDB, 5000);
  }
}
connectDB();

// ================================================================
// SERVE STATIC FILES
// ================================================================
app.use(express.static(ROOT));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(ROOT, 'about.html')));

// ================================================================
// PAYSTACK: Initialize transaction
// ================================================================
app.post('/api/paystack/initialize', async (req, res) => {
  const { email, amount } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'Missing email or amount' });
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: Math.round(amount * 100),
        currency: 'KES',
        reference: 'LNE_' + Date.now(),
        metadata: {
          custom_fields: [{
            display_name: 'Shop',
            variable_name: 'shop',
            value: 'Late Night Epiphanies'
          }]
        }
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      access_code: response.data.data.access_code,
      reference: response.data.data.reference
    });
  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

// ================================================================
// PAYSTACK: Verify + Save order
// ================================================================
app.get('/api/paystack/verify/:reference', async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${req.params.reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = response.data.data;
    if (data.status === 'success') {
      try {
        await Order.findOneAndUpdate(
          { reference: data.reference },
          {
            reference: data.reference,
            email:     data.customer.email,
            amount:    data.amount / 100,
            currency:  data.currency,
            status:    'paid',
            paid_at:   data.paid_at,
            channel:   data.channel,
            items:     data.metadata?.custom_fields?.[0]?.value || ''
          },
          { upsert: true, new: true }
        );
        console.log(`✅ Order saved: ${data.reference}`);
      } catch (dbErr) {
        console.error('DB save error:', dbErr.message);
      }
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
        {
          reference: data.reference,
          email:     data.customer.email,
          amount:    data.amount / 100,
          currency:  data.currency,
          status:    'paid',
          paid_at:   data.paid_at,
          channel:   data.channel,
          items:     data.metadata?.custom_fields?.[0]?.value || ''
        },
        { upsert: true, new: true }
      );
      console.log(`✅ Webhook order saved: ${data.reference}`);
    } catch (err) {
      console.error('Webhook DB error:', err.message);
    }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock/:productId', async (req, res) => {
  try {
    const item = await Stock.findOne({ productId: req.params.productId });
    if (!item) return res.status(404).json({ error: 'Product not found' });
    res.json({
      success:   true,
      productId: item.productId,
      sold:      item.sold,
      maxPrints: item.maxPrints,
      remaining: item.maxPrints - item.sold,
      soldOut:   item.sold >= item.maxPrints
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ORDERS API
// ================================================================
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ created_at: -1 });
    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Serving files from: ${ROOT}`);
});
