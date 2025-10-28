import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  PORT = 10000
} = process.env;

// Cache token
let oauthToken = null;
let tokenExpiry = 0;

async function getOAuthToken() {
  if (oauthToken && Date.now() < tokenExpiry) return oauthToken;

  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );

  oauthToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
  return oauthToken;
}

app.post('/api/pay', async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Missing phone or amount' });

  try {
    const token = await getOAuthToken();
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'LNE' + Date.now(),
      TransactionDesc: 'Art Purchase'
    };

    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, checkoutId: response.data.CheckoutRequestID });
  } catch (err) {
    console.error('STK Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.post('/api/m-pesa/callback', (req, res) => {
  console.log('Callback:', JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});