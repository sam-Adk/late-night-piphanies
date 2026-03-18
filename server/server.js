import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ServerApiVersion } from 'mongodb';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.join(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json());

const { PAYSTACK_SECRET_KEY, MONGODB_URI, PORT = 10000 } = process.env;

// ================================================================
// MONGODB CONNECTION
// ================================================================
let db;
const client = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true
  }
});

async function connectDB() {
  try {
    await client.connect();
    db = client.db('late-night-epiphanies');
    console.log('✅ Connected to MongoDB!');

    // Create indexes for fast lookups
    await db.collection('orders').createIndex({ reference: 1 }, { unique: true });
    await db.collection('orders').createIndex({ email: 1 });
    await db.collection('stock').createIndex({ productId: 1 }, { unique: true });

    // Initialize stock for all 39 products (max 10 prints each)
    // Only inserts if the product doesn't exist yet
    const products = Array.from({ length: 39 }, (_, i) => ({
      productId: `p${i + 1}`,
      sold: 0,
      maxPrints: 10
    }));
    for (const p of products) {
      await db.collection('stock').updateOne(
        { productId: p.productId },
        { $setOnInsert: p },
        { upsert: true }
      );
    }
    console.log('✅ Stock collection ready!');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
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
// POST /api/paystack/initialize
// ================================================================
app.post('/api/paystack/initialize', async (req, res) => {
  const { email, amount } = req.body;
  if (!email || !amount) {
    return res.status(400).json({ error: 'Missing email or amount' });
  }
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
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
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
// PAYSTACK: Verify transaction + Save to MongoDB
// GET /api/paystack/verify/:reference
// ================================================================
app.get('/api/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = response.data.data;

    if (data.status === 'success') {
      // Save order to MongoDB
      if (db) {
        try {
          await db.collection('orders').updateOne(
            { reference: data.reference },
            {
              $set: {
                reference:  data.reference,
                email:      data.customer.email,
                amount:     data.amount / 100,
                currency:   data.currency,
                status:     'paid',
                paid_at:    data.paid_at,
                channel:    data.channel,
                items:      data.metadata?.custom_fields?.[0]?.value || '',
                created_at: new Date()
              }
            },
            { upsert: true }
          );
          console.log(`✅ Order saved: ${data.reference}`);
        } catch (dbErr) {
          console.error('DB save error:', dbErr.message);
        }
      }

      res.json({
        success:   true,
        amount:    data.amount / 100,
        email:     data.customer.email,
        reference: data.reference,
        paid_at:   data.paid_at
      });
    } else {
      res.json({ success: false, message: 'Payment not completed', status: data.status });
    }
  } catch (err) {
    console.error('Paystack verify error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ================================================================
// PAYSTACK: Webhook — auto-saves payment when Paystack confirms
// POST /api/paystack/webhook
// ================================================================
app.post('/api/paystack/webhook', async (req, res) => {
  const event = req.body;

  if (event.event === 'charge.success') {
    const data = event.data;
    console.log('✅ Webhook payment received:', data.reference);

    if (db) {
      try {
        // Save/update order
        await db.collection('orders').updateOne(
          { reference: data.reference },
          {
            $set: {
              reference:   data.reference,
              email:       data.customer.email,
              amount:      data.amount / 100,
              currency:    data.currency,
              status:      'paid',
              paid_at:     data.paid_at,
              channel:     data.channel,
              items:       data.metadata?.custom_fields?.[0]?.value || '',
              created_at:  new Date()
            }
          },
          { upsert: true }
        );
        console.log(`✅ Order saved via webhook: ${data.reference}`);
      } catch (dbErr) {
        console.error('Webhook DB error:', dbErr.message);
      }
    }
  }
  res.sendStatus(200);
});

// ================================================================
// STOCK: Get stock for all products
// GET /api/stock
// ================================================================
app.get('/api/stock', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not connected' });
  try {
    const stock = await db.collection('stock').find({}).toArray();
    res.json({ success: true, stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// STOCK: Get stock for one product
// GET /api/stock/:productId
// ================================================================
app.get('/api/stock/:productId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not connected' });
  try {
    const item = await db.collection('stock').findOne({ productId: req.params.productId });
    if (!item) return res.status(404).json({ error: 'Product not found' });
    res.json({
      success:    true,
      productId:  item.productId,
      sold:       item.sold,
      maxPrints:  item.maxPrints,
      remaining:  item.maxPrints - item.sold,
      soldOut:    item.sold >= item.maxPrints
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ORDERS: Get all orders (admin view)
// GET /api/orders
// ================================================================
app.get('/api/orders', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not connected' });
  try {
    const orders = await db.collection('orders')
      .find({})
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Serving files from: ${ROOT}`);
});
