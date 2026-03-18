import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ ROOT of the repo (one level UP from the server/ folder)
const ROOT = path.join(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json());

const { PAYSTACK_SECRET_KEY, PORT = 10000 } = process.env;

// ✅ Serve all static files from the repo root
app.use(express.static(ROOT));

// ✅ Home route
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ✅ About route
app.get('/about', (req, res) => {
  res.sendFile(path.join(ROOT, 'about.html'));
});

// ================================================================
// PAYSTACK: Initialize a transaction
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
// PAYSTACK: Verify a transaction
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
      res.json({
        success: true,
        amount: data.amount / 100,
        email: data.customer.email,
        reference: data.reference,
        paid_at: data.paid_at
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
// PAYSTACK: Webhook
// ================================================================
app.post('/api/paystack/webhook', (req, res) => {
  const event = req.body;
  if (event.event === 'charge.success') {
    console.log('✅ Payment received:', {
      reference: event.data.reference,
      amount: event.data.amount / 100,
      email: event.data.customer.email
    });
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Serving files from: ${ROOT}`);
});
