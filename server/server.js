import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const { PAYSTACK_SECRET_KEY, PORT = 10000 } = process.env;

// ================================================================
// PAYSTACK: Initialize a transaction
// POST /api/paystack/initialize
// Body: { email, amount }  — amount in KES (we multiply by 100 here)
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
        amount: Math.round(amount * 100), // Convert KES to kobo/cents
        currency: 'KES',
        reference: 'LNE_' + Date.now(),
        metadata: {
          custom_fields: [
            {
              display_name: 'Shop',
              variable_name: 'shop',
              value: 'Late Night Epiphanies'
            }
          ]
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
// GET /api/paystack/verify/:reference
// ================================================================
app.get('/api/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = response.data.data;

    if (data.status === 'success') {
      res.json({
        success: true,
        amount: data.amount / 100, // Convert back to KES
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
// PAYSTACK: Webhook (Paystack calls this after payment)
// POST /api/paystack/webhook
// ================================================================
app.post('/api/paystack/webhook', (req, res) => {
  // In production, verify the Paystack-Signature header here
  const event = req.body;

  if (event.event === 'charge.success') {
    const data = event.data;
    console.log('✅ Payment received:', {
      reference: data.reference,
      amount: data.amount / 100,
      email: data.customer.email,
      paid_at: data.paid_at
    });
    // TODO: Mark order as paid in your database here
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Paystack backend running on port ${PORT}`);
});
