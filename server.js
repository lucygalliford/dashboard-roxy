const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI         = process.env.REDIRECT_URI || 'https://lu-dashboard-proxy.onrender.com/auth/callback';
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

let tokenStore = {};

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Lu Dashboard Proxy', authed: !!tokenStore.access_token }));

app.get('/auth/login', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.labels',
    'https://www.googleapis.com/auth/calendar.readonly'
  ].join(' ');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Auth error: ${error}</h2>`);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
    });
    const tokens = await response.json();
    if (tokens.error) return res.send(`<h2>Token error: ${tokens.error_description}</h2>`);
    tokenStore = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry: Date.now() + (tokens.expires_in * 1000) };
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>✓ Gmail & Calendar connected!</h2><p>You can close this tab and go back to your dashboard.</p><script>if(window.opener){window.opener.postMessage('auth_success','*');window.close();}</script></body></html>`);
  } catch (err) { res.send(`<h2>Error: ${err.message}</h2>`); }
});

async function getValidAccessToken() {
  if (!tokenStore.access_token) throw new Error('NOT_AUTHENTICATED');
  if (Date.now() > tokenStore.expiry - 60000) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: tokenStore.refresh_token, grant_type: 'refresh_token' })
    });
    const tokens = await response.json();
    if (tokens.error) throw new Error('Token refresh failed');
    tokenStore.access_token = tokens.access_token;
    tokenStore.expiry = Date.now() + (tokens.expires_in * 1000);
  }
  return tokenStore.access_token;
}

app.get('/auth/status', (req, res) => res.json({ authenticated: !!tokenStore.access_token }));

app.get('/gmail/unread', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=50`, { headers: { Authorization: `Bearer ${token}` } });
    const listData = await listRes.json();
    if (!listData.messages?.length) return res.json({ messages: [], total: 0 });
    const ids = listData.messages.slice(0, 25);
    const messages = await Promise.all(ids.map(async ({ id }) => {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${token}` } });
      return msgRes.json();
    }));
    res.json({ messages, total: listData.resultSizeEstimate || messages.length });
  } catch (err) { res.status(err.message === 'NOT_AUTHENTICATED' ? 401 : 500).json({ error: err.message }); }
});

app.post('/gmail/label', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const { threadId, labelName, archive } = req.body;
    const labelsRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: { Authorization: `Bearer ${token}` } });
    const labelsData = await labelsRes.json();
    let label = labelsData.labels?.find(l => l.name === labelName);
    if (!label) {
      const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) });
      label = await createRes.json();
    }
    const modifications = { addLabelIds: [label.id], removeLabelIds: archive ? ['INBOX'] : [] };
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(modifications) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/gmail/draft', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const { to, subject, body } = req.body;
    const email = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
    const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { raw: encoded } }) });
    const draft = await draftRes.json();
    res.json({ success: true, draftId: draft.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/calendar/today', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${startOfDay}&timeMax=${endOfDay}&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${token}` } });
    const calData = await calRes.json();
    const events = (calData.items || []).map(ev => {
      const start = ev.start?.dateTime || ev.start?.date;
      const end = ev.end?.dateTime || ev.end?.date;
      const startTime = start ? new Date(start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '00:00';
      const endTime = end ? new Date(end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '00:00';
      const durationMins = start && end ? Math.round((new Date(end) - new Date(start)) / 60000) : 60;
      return { id: ev.id, title: ev.summary || 'Untitled', startTime, endTime, durationMins, type: 'event', needsPrepTask: durationMins >= 15 && !!(ev.summary || '').toLowerCase().match(/call|meet|interview|sync|chat/), prepTaskText: `Prep for: ${ev.summary}` };
    });
    res.json({ events });
  } catch (err) { res.status(err.message === 'NOT_AUTHENTICATED' ? 401 : 500).json({ error: err.message }); }
});

app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(req.body) });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lu Dashboard Proxy running on port ${PORT}`));

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Claude Dashboard Proxy' }));

// Proxy endpoint — forwards requests to Anthropic API
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
