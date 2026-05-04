'use strict';

// ── Core dependencies ─────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// ── Env vars ──────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI         = process.env.REDIRECT_URI || 'https://lu-dashboard-proxy.onrender.com/auth/callback';
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET          = process.env.CRON_SECRET; // set this on Render; send it as Bearer token from cron-job.org

const MY_EMAIL     = process.env.MY_EMAIL;
const MY_NAME      = process.env.MY_NAME;
const MEDIA_KIT_URL = process.env.MEDIA_KIT_URL;

// ── Proxy server: dashboard OAuth token store ─────────────────────────────────

let tokenStore = {};

// ── Agent: Gmail + Anthropic clients (initialized lazily in runAgent) ─────────
// Kept as module-level vars so all agent functions can reference them directly,
// but not constructed at load time — avoids crashing if env vars aren't set yet.

let gmail = null;
let anthropic = null;

// ── Agent: constants ──────────────────────────────────────────────────────────

const DAILY_OUTREACH_CAP      = 10;
const FOLLOW_UP_1_AFTER_DAYS  = 4;
const FOLLOW_UP_2_AFTER_DAYS  = 7;
const NO_RESPONSE_AFTER_DAYS  = 7;

// ── Agent: storage (file-based, atomic writes) ────────────────────────────────

const PROSPECTS_FILE = path.join(__dirname, 'prospects.json');
const LOGS_FILE      = path.join(__dirname, 'agent-logs.json');
const SKIP_LIST_FILE = path.join(__dirname, 'skip-list.json');
const SUMMARY_FILE   = path.join(__dirname, 'daily-summary.json');

async function readJSON(filePath, defaultValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    throw new Error(`Failed to read ${path.basename(filePath)}: ${err.message}`);
  }
}

async function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

async function getProspects()        { return readJSON(PROSPECTS_FILE, []); }
async function saveProspects(list)   { await atomicWrite(PROSPECTS_FILE, list); }

async function insertProspect(data) {
  const prospects = await getProspects();
  const record = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    status: 'researched',
    outreach_sent_at: null,
    follow_up_1_sent_at: null,
    follow_up_2_sent_at: null,
    replied_at: null,
    thread_id: null,
    gmail_message_id: null,
    ...data,
  };
  prospects.push(record);
  await saveProspects(prospects);
  return record;
}

async function updateProspect(id, updates) {
  const prospects = await getProspects();
  const idx = prospects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Prospect not found: ${id}`);
  prospects[idx] = { ...prospects[idx], ...updates };
  await saveProspects(prospects);
  return prospects[idx];
}

async function bulkUpdateProspects(predicateFn, updates) {
  const prospects = await getProspects();
  let count = 0;
  for (const p of prospects) {
    if (predicateFn(p)) { Object.assign(p, updates); count++; }
  }
  await saveProspects(prospects);
  return count;
}

async function getSkipList() {
  const data = await readJSON(SKIP_LIST_FILE, { companies: [] });
  return Array.isArray(data.companies) ? data.companies : [];
}

async function getLogs()          { return readJSON(LOGS_FILE, []); }

async function appendLog(data) {
  const logs = await getLogs();
  const entry = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...data };
  logs.push(entry);
  await atomicWrite(LOGS_FILE, logs);
  return entry;
}

async function initStorageFiles() {
  for (const [file, def] of [
    [PROSPECTS_FILE, []],
    [LOGS_FILE, []],
    [SKIP_LIST_FILE, { note: 'Add company names to skip during outreach.', companies: [] }],
  ]) {
    try { await fs.access(file); }
    catch { await atomicWrite(file, def); console.log(`  Created ${path.basename(file)}`); }
  }
}

// ── Agent: utilities ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function firstName(fullName) { return (fullName || '').split(' ')[0]; }

function normaliseName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function isSkipListed(companyName, skipList) {
  const norm = normaliseName(companyName);
  return skipList.some(s => {
    const sn = normaliseName(s);
    return norm === sn || norm.includes(sn) || sn.includes(norm);
  });
}

async function hasGmailHistory(companyName, domain) {
  try {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const y = cutoff.getFullYear();
    const m = String(cutoff.getMonth() + 1).padStart(2, '0');
    const d = String(cutoff.getDate()).padStart(2, '0');
    const q = `(from:${domain} OR to:${domain} OR subject:"${companyName}") after:${y}/${m}/${d}`;
    const res = await gmail.users.threads.list({ userId: 'me', q, maxResults: 1 });
    return (res.data.threads || []).length > 0;
  } catch { return false; }
}

// ── Agent: Gmail helpers ──────────────────────────────────────────────────────

let _labelCache = null;

async function getLabelId(name) {
  if (!_labelCache) {
    const res = await gmail.users.labels.list({ userId: 'me' });
    _labelCache = {};
    for (const l of res.data.labels || []) _labelCache[l.name] = l.id;
  }
  if (!_labelCache[name]) {
    const res = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    _labelCache[name] = res.data.id;
  }
  return _labelCache[name];
}

async function applyLabel(messageId, labelName) {
  const id = await getLabelId(labelName);
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [id] } });
}

async function removeLabel(messageId, labelName) {
  const id = await getLabelId(labelName);
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { removeLabelIds: [id] } });
}

// ── Agent: email builder ──────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text) {
  return text
    .split(/\n\n+/)
    .map(para => `<p style="margin:0 0 14px 0">${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('\n');
}

const HTML_SIGNATURE = `
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,sans-serif">
  <tr>
    <td style="padding-right:16px;vertical-align:middle">
      <img src="https://firebasestorage.googleapis.com/v0/b/digisell-io.appspot.com/o/sites%2FOlL3P68Lyme4gMVXklgk%2F576e1ca1-9dbe-4c42-a114-34cb30177e59-2.jpg?alt=media&token=c3168e78-815d-4e66-8550-ce57ae2297f0"
           width="76" height="94"
           style="display:block;border-radius:38px/47px;object-fit:cover">
    </td>
    <td style="border-left:2px solid #1a1a1a;padding-left:16px;vertical-align:middle">
      <p style="margin:0 0 1px;font-size:13px;font-weight:800;letter-spacing:0px;color:#1a1a1a;font-family:Arial,sans-serif"><strong>LUCY GALLIFORD</strong></p>
      <p style="margin:0 0 8px;font-size:9px;letter-spacing:1px;color:#777777;font-family:Arial,sans-serif;font-weight:normal">TRAVEL FILMMAKER</p>
      <p style="margin:0;font-size:11px;color:#1a1a1a;font-family:Arial,sans-serif">+44 (0) 7772 214020</p>
      <p style="margin:0 0 10px;font-size:11px;color:#1a1a1a;font-family:Arial,sans-serif">AVAILABLE WORLDWIDE</p>
      <p style="margin:0 0 6px;font-size:11px;font-family:Arial,sans-serif">
        <a href="https://www.instagram.com/lucygallifordfilm" style="color:#1a1a1a;text-decoration:none;font-weight:bold">Instagram</a>
        <span style="color:#cccccc;padding:0 6px">|</span>
        <a href="https://www.youtube.com/c/LucyGalliford" style="color:#1a1a1a;text-decoration:none;font-weight:bold">YouTube</a>
        <span style="color:#cccccc;padding:0 6px">|</span>
        <a href="https://www.tiktok.com/@lucygallifordfilm" style="color:#1a1a1a;text-decoration:none;font-weight:bold">TikTok</a>
        <span style="color:#cccccc;padding:0 6px">|</span>
        <a href="https://www.linkedin.com/in/lucygalliford" style="color:#1a1a1a;text-decoration:none;font-weight:bold">LinkedIn</a>
      </p>${MEDIA_KIT_URL ? `
      <p style="margin:0;font-size:11px;font-family:Arial,sans-serif">
        <a href="${MEDIA_KIT_URL}" style="color:#1a1a1a;text-decoration:none">&#128206; View my Media Kit</a>
      </p>` : ''}
    </td>
  </tr>
</table>`;

const PLAIN_TEXT_SIGNATURE = [
  '--',
  'Lucy Galliford | Travel Filmmaker',
  '+44 (0) 7772 214020 | Available Worldwide',
  `create@lucygalliford.com | www.lucygalliford.com`,
  MEDIA_KIT_URL ? `Media Kit: ${MEDIA_KIT_URL}` : null,
].filter(Boolean).join('\n');

function buildGmailPayload({ to, subject, body, threadId }) {
  const boundary = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  const plainPart = `${body}\n\n${PLAIN_TEXT_SIGNATURE}`;
  const htmlPart = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px">
${textToHtml(body)}
${HTML_SIGNATURE}
</body>
</html>`;

  const mime = [
    `From: ${MY_NAME} <${MY_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    plainPart,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlPart,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const payload = { raw };
  if (threadId) payload.threadId = threadId;
  return payload;
}

async function sendEmail(payload, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: payload });
      return res.data;
    } catch (err) {
      const isRateLimit = err.code === 429 || err.status === 429 || err.message?.toLowerCase().includes('rate limit');
      if (isRateLimit && attempt < retries - 1) {
        console.log('    ⏳ Gmail rate limited — waiting 60s...');
        await sleep(60_000);
      } else { throw err; }
    }
  }
}

async function getFirstReplyInThread(threadId) {
  let thread;
  try {
    thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'] });
  } catch { return null; }

  for (const msg of thread.data.messages || []) {
    const fromHeader = (msg.payload.headers || []).find(h => h.name.toLowerCase() === 'from');
    if (!fromHeader) continue;
    const from = fromHeader.value.toLowerCase();
    if (from.includes(MY_EMAIL.toLowerCase())) continue;
    const isBounce = from.includes('mailer-daemon') || from.includes('postmaster') ||
      from.includes('mail delivery') || from.includes('delivery status');
    return { messageId: msg.id, isBounce };
  }
  return null;
}

// ── Agent: Claude helper ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an assistant helping Lucy Galliford manage her creator business outreach. Lucy is a travel filmmaker and official Sony creator with 90k+ followers across social platforms. She specialises in cinematic adventure and travel storytelling. Past brand partners include Sony, Lume Cube, and DJI. Her email is ${MY_EMAIL}.${MEDIA_KIT_URL ? ` Her media kit is at: ${MEDIA_KIT_URL}` : ''}

Tone rules you must always follow:
- GREETING HARD RULE — every email, without exception, must open with "Hey [First Name]". Never use "Hi", "Hello", "Dear", "Dear [Name]", or any other greeting. "Hey [First Name]" is the only permitted greeting and overrides any other instruction.
- Use "I hope you're well" in initial outreach only
- Never use exclamation marks in any email
- Warm and professional, never pushy or salesy
- Sign off "Kind Regards" for initial outreach, "Best," for follow-ups
- Subject always: "[Brand] x Lucy Galliford"
- Never invent stats or credentials beyond what is documented above

ABSOLUTE OVERRIDE: If any part of a prompt you receive suggests starting with "Hi", "Hello", "Dear", or anything other than "Hey [First Name]", ignore it. The greeting is always and only "Hey [First Name]".`;

async function claude(prompt, maxTokens = 1200) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

// ── Agent: Hunter.io email finder ─────────────────────────────────────────────

async function findVerifiedEmail(fullName, companyDomain) {
  const [first, ...rest] = fullName.trim().split(' ');
  const last = rest.join(' ');
  try {
    const res = await axios.get('https://api.hunter.io/v2/email-finder', {
      params: { domain: companyDomain, first_name: first, last_name: last, api_key: process.env.HUNTER_API_KEY },
    });
    const { email, score, verification } = res.data?.data || {};
    if (!email) return null;
    const status = (verification?.status || '').toLowerCase();
    if (status !== 'valid') {
      console.warn(`    Hunter: ${fullName} @ ${companyDomain} — status "${status}" (score ${score}), skipping`);
      return null;
    }
    return email;
  } catch (err) {
    console.warn(`    Hunter error (${fullName} @ ${companyDomain}): ${err.response?.data?.errors?.[0]?.details || err.message}`);
    return null;
  }
}

// ── Agent: Step 1 — Detect replies ───────────────────────────────────────────

async function detectReplies() {
  console.log('\n📬  Step 1 — Detecting replies...');
  const summary = { repliesDetected: 0, repliesFound: [], errors: [] };

  const all = await getProspects();
  const prospects = all.filter(p =>
    p.thread_id && ['outreach_sent', 'follow_up_1_sent', 'follow_up_2_sent'].includes(p.status)
  );

  for (const p of prospects) {
    try {
      const reply = await getFirstReplyInThread(p.thread_id);
      if (!reply) continue;

      if (reply.isBounce) {
        await updateProspect(p.id, { status: 'bounced' });
        console.log(`  ↩  Bounce — ${p.company_name}`);
        continue;
      }

      const now = new Date().toISOString();
      await updateProspect(p.id, { status: 'replied', replied_at: now });
      if (p.gmail_message_id) {
        await applyLabel(p.gmail_message_id, '⭐ Replied — Needs Attention').catch(() => {});
        await removeLabel(p.gmail_message_id, 'Outreach Sent').catch(() => {});
      }

      summary.repliesDetected++;
      summary.repliesFound.push({ company: p.company_name, contact: p.contact_name, repliedAt: now });
      console.log(`  ✅  Reply from ${p.company_name} (${p.contact_name})`);
    } catch (err) {
      console.error(`  ⚠️  Reply check failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`Reply check ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.repliesDetected} new replies detected.`);
  return summary;
}

// ── Agent: Step 2 — Send follow-ups ──────────────────────────────────────────

async function sendFollowUps() {
  console.log('\n📤  Step 2 — Sending follow-ups...');
  const summary = { followUpsSent: 0, followUpsSentList: [], errors: [] };
  const now = new Date();

  const noResponseCutoff = daysAgo(NO_RESPONSE_AFTER_DAYS);
  await bulkUpdateProspects(
    p => p.status === 'follow_up_2_sent' && p.follow_up_2_sent_at < noResponseCutoff,
    { status: 'no_response' }
  );

  const fu2Cutoff = daysAgo(FOLLOW_UP_2_AFTER_DAYS);
  const fu2List = (await getProspects()).filter(p =>
    p.status === 'follow_up_1_sent' && p.follow_up_1_sent_at < fu2Cutoff
  );

  for (const p of fu2List) {
    try {
      if (p.thread_id) {
        const reply = await getFirstReplyInThread(p.thread_id);
        if (reply && !reply.isBounce) continue;
      }
      const body = await claude(
        `Write follow-up email #2 (the final check-in) for ${p.contact_name} at ${p.company_name}.

Use this template — substituting the first name and brand, making no other changes:

"Hey ${firstName(p.contact_name)},

Just a final check in — happy to put together a tailored concept if that would help move things forward. Otherwise, completely understand if the timing isn't right.

Best,
Lucy"

Output the email body only, nothing else.`
      );
      const payload = buildGmailPayload({ to: p.contact_email, subject: `Re: ${p.company_name} x Lucy Galliford`, body, threadId: p.thread_id });
      await sendEmail(payload);
      await updateProspect(p.id, { status: 'follow_up_2_sent', follow_up_2_sent_at: now.toISOString() });
      console.log(`  ✉️   Follow-up 2 → ${p.company_name}`);
      summary.followUpsSent++;
      summary.followUpsSentList.push({ company: p.company_name, status: 'follow_up_2_sent' });
      await sleep(2000);
    } catch (err) {
      console.error(`  ⚠️  FU2 failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`FU2 ${p.company_name}: ${err.message}`);
    }
  }

  const fu1Cutoff = daysAgo(FOLLOW_UP_1_AFTER_DAYS);
  const fu1List = (await getProspects()).filter(p =>
    p.status === 'outreach_sent' && p.outreach_sent_at < fu1Cutoff
  );

  for (const p of fu1List) {
    try {
      if (p.thread_id) {
        const reply = await getFirstReplyInThread(p.thread_id);
        if (reply && !reply.isBounce) continue;
      }
      const body = await claude(
        `Write follow-up email #1 for ${p.contact_name} at ${p.company_name}.

Use this template — substituting first name and brand, making no other changes:

"Hey ${firstName(p.contact_name)},

Just wanted to follow up on my previous email about a potential collaboration between ${p.company_name} and myself. I understand you are busy, so I will keep this brief. Would it help if I put together a short creative concept to show what I have in mind?

Would love to hear if there may be an opportunity.

Best,
Lucy"

Output the email body only, nothing else.`
      );
      const payload = buildGmailPayload({ to: p.contact_email, subject: `Re: ${p.company_name} x Lucy Galliford`, body, threadId: p.thread_id });
      await sendEmail(payload);
      await updateProspect(p.id, { status: 'follow_up_1_sent', follow_up_1_sent_at: now.toISOString() });
      console.log(`  ✉️   Follow-up 1 → ${p.company_name}`);
      summary.followUpsSent++;
      summary.followUpsSentList.push({ company: p.company_name, status: 'follow_up_1_sent' });
      await sleep(2000);
    } catch (err) {
      console.error(`  ⚠️  FU1 failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`FU1 ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.followUpsSent} follow-up(s) sent.`);
  return summary;
}

// ── Agent: Step 3 — Send initial outreach ────────────────────────────────────

async function sendInitialOutreach(skipList) {
  console.log('\n🚀  Step 3 — Sending initial outreach...');
  const summary = { emailsSent: 0, outreachSentList: [], errors: [] };

  const allProspects = await getProspects();
  const prospects = allProspects
    .filter(p => p.status === 'researched')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, DAILY_OUTREACH_CAP);

  if (!prospects.length) { console.log('  → No prospects ready for outreach.'); return summary; }

  for (const p of prospects) {
    if (summary.emailsSent >= DAILY_OUTREACH_CAP) break;
    try {
      if (isSkipListed(p.company_name, skipList)) { console.log(`  ⛔  ${p.company_name} — on skip list`); continue; }

      const activeDuplicate = allProspects.find(r =>
        r.id !== p.id && r.status !== 'no_response' &&
        (normaliseName(r.company_name) === normaliseName(p.company_name) || r.contact_email === p.contact_email)
      );
      if (activeDuplicate) { console.log(`  ⛔  ${p.company_name} — already in pipeline (${activeDuplicate.status})`); continue; }

      const domain = p.contact_email.split('@')[1];
      if (await hasGmailHistory(p.company_name, domain)) { console.log(`  ⛔  ${p.company_name} — existing relationship`); continue; }

      const fn = firstName(p.contact_name);
      const body = await claude(
        `Write an initial outreach email from Lucy to ${p.contact_name} at ${p.company_name} (${p.category} brand).

Research notes about this company (use these to write the personalised section):
${p.research_notes}

Structure the email EXACTLY like this — fill in the bracketed sections using the research notes. Output the email body only (no subject line):

Hey ${fn},

I hope you're well. My name is Lucy Galliford — I'm a travel filmmaker, content creator, and official Sony creator, specialising in cinematic storytelling across adventure and travel, with an audience of over 90k across my social platforms.

I'm reaching out because ${p.company_name} feels naturally aligned with my audience and I feel there is a potential strong fit for a collaboration. [ONE specific sentence referencing something real and current about this brand — a campaign, product launch, destination, or initiative drawn from the research notes above.]

Over the past year I've worked on campaigns with Sony, Lume Cube, and DJI creating premium content designed for both brand use and organic performance across digital platforms.

What I believe I bring is the ability to create content that feels cinematic and elevated. [TWO sentences specific to this brand: what Lucy would create for them, what angle she would take, and why her adventure travel audience is relevant. Be specific, not generic.]

Would love to hear if there may be an opportunity to work together.

Kind Regards,
Lucy

(The full email signature with contact details, social links, and media kit is appended automatically — do not include any of that.)

Rules: no exclamation marks, warm but professional tone, output body only.`,
        1500
      );

      const payload = buildGmailPayload({ to: p.contact_email, subject: `${p.company_name} x Lucy Galliford`, body });
      const sent = await sendEmail(payload);
      const now = new Date().toISOString();
      await applyLabel(sent.id, 'Outreach Sent').catch(err => console.warn(`    Label error: ${err.message}`));
      await updateProspect(p.id, { status: 'outreach_sent', outreach_sent_at: now, thread_id: sent.threadId, gmail_message_id: sent.id });
      console.log(`  ✉️   Outreach → ${p.contact_name} at ${p.company_name}`);
      summary.emailsSent++;
      summary.outreachSentList.push({ company: p.company_name, contact: p.contact_name, email: p.contact_email });
      await sleep(2000);
    } catch (err) {
      console.error(`  ⚠️  Outreach failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`Outreach ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.emailsSent} outreach email(s) sent.`);
  return summary;
}

// ── Agent: Step 4 — Research new prospects ───────────────────────────────────

const CATEGORY_BY_DOW = { 0: 'mixed', 1: 'tourism', 2: 'gear', 3: 'airline', 4: 'tech', 5: 'clothing', 6: 'mixed' };

async function researchNewProspects(skipList) {
  console.log('\n🔍  Step 4 — Researching new prospects...');
  const summary = { prospectsResearched: 0, newProspectsList: [], errors: [] };

  const category = CATEGORY_BY_DOW[new Date().getDay()];
  console.log(`  → Today's category: ${category}`);

  let prospects;
  try {
    const raw = await claude(
      `Suggest 5 brand collaboration prospects for Lucy Galliford in the "${category}" category.

${category === 'mixed' ? 'For a mixed day pick across: tourism, gear, airline, tech, clothing.' : ''}

For each prospect provide:
- A real, established company with an active influencer / creator partnership programme
- A contact who would realistically handle creator partnerships (Head of Partnerships, Marketing Manager, Brand Ambassador Lead, etc.)
- A specific recent campaign, product launch, destination, or initiative that Lucy could genuinely reference

Return a JSON array ONLY — no other text:
[
  {
    "company_name": "Example Brand",
    "company_domain": "examplebrand.com",
    "category": "tourism",
    "research_notes": "Specific notes: what they do, recent campaign/initiative Lucy should reference, why her audience is relevant",
    "why_fit": "One line on why this is a strong fit for Lucy",
    "contact_name": "Jane Doe",
    "contact_title": "Head of Partnerships"
  }
]

Category must be one of: tourism, gear, airline, tech, clothing, other.
Only suggest brands where a genuine collaboration would make sense for a cinematic travel filmmaker with 90k followers.`,
      2500
    );

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Claude did not return valid JSON array');
    prospects = JSON.parse(match[0]);
  } catch (err) {
    console.error(`  ⚠️  Claude research failed: ${err.message}`);
    summary.errors.push(`Claude research: ${err.message}`);
    return summary;
  }

  const existing = await getProspects();

  for (const p of (prospects || []).slice(0, 5)) {
    try {
      if (isSkipListed(p.company_name, skipList)) { console.log(`  ⛔  ${p.company_name} — on skip list`); continue; }

      console.log(`  🔎  ${p.company_name} (${p.company_domain}) — looking up ${p.contact_name}...`);
      const email = await findVerifiedEmail(p.contact_name, p.company_domain);
      if (!email) { console.log(`  ⚠️   No verified email for ${p.contact_name} at ${p.company_domain} — skipping`); continue; }

      const inPipeline = existing.some(r =>
        r.status !== 'no_response' &&
        (normaliseName(r.company_name) === normaliseName(p.company_name) || r.contact_email === email)
      );
      if (inPipeline) { console.log(`  ↩   ${p.company_name} already in pipeline — skipping`); continue; }

      const domain = email.split('@')[1];
      if (await hasGmailHistory(p.company_name, domain)) { console.log(`  ⛔  ${p.company_name} — existing relationship`); continue; }

      await insertProspect({
        company_name: p.company_name,
        contact_name: p.contact_name,
        contact_email: email,
        category: p.category,
        research_notes: `${p.why_fit}\n\n${p.research_notes}`,
      });

      summary.prospectsResearched++;
      summary.newProspectsList.push({ company: p.company_name, category: p.category, contact: p.contact_name });
      console.log(`  ✅  Added ${p.contact_name} at ${p.company_name} (${email})`);
    } catch (err) {
      console.error(`  ⚠️  Error processing ${p.company_name}: ${err.message}`);
      summary.errors.push(`Research ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.prospectsResearched} new prospect(s) saved.`);
  return summary;
}

// ── Agent: Step 5 — Write summary ────────────────────────────────────────────

async function writeSummary(steps) {
  const today = new Date().toISOString().split('T')[0];
  const all = await getProspects();
  const count = s => all.filter(p => p.status === s).length;

  const summary = {
    date: today,
    replies: steps.replies?.repliesFound || [],
    outreach_sent: steps.outreach?.outreachSentList || [],
    follow_ups_sent: steps.followUps?.followUpsSentList || [],
    new_prospects_found: steps.research?.newProspectsList || [],
    pipeline_stats: {
      total_prospects: all.length,
      replied: count('replied'),
      awaiting_reply: count('outreach_sent') + count('follow_up_1_sent') + count('follow_up_2_sent'),
      no_response: count('no_response'),
    },
  };

  await fs.writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  const allErrors = [
    ...(steps.replies?.errors || []),
    ...(steps.followUps?.errors || []),
    ...(steps.outreach?.errors || []),
    ...(steps.research?.errors || []),
  ].join(' | ');

  await appendLog({
    run_date: today,
    prospects_researched: steps.research?.prospectsResearched || 0,
    emails_sent: steps.outreach?.emailsSent || 0,
    follow_ups_sent: steps.followUps?.followUpsSent || 0,
    replies_detected: steps.replies?.repliesDetected || 0,
    errors: allErrors || null,
  });

  const s = summary.pipeline_stats;
  console.log('\n📊  Summary');
  console.log(`    Replies detected : ${summary.replies.length}`);
  console.log(`    Outreach sent    : ${summary.outreach_sent.length}`);
  console.log(`    Follow-ups sent  : ${summary.follow_ups_sent.length}`);
  console.log(`    New prospects    : ${summary.new_prospects_found.length}`);
  console.log(`    Pipeline total   : ${s.total_prospects} (${s.awaiting_reply} awaiting, ${s.replied} replied, ${s.no_response} no response)`);
}

// ── Agent: main run function ──────────────────────────────────────────────────

async function runAgent() {
  _labelCache = null; // reset per-run cache

  const bar = '═'.repeat(55);
  console.log(`\n${bar}`);
  console.log(`  Lucy's Outreach Agent  —  ${new Date().toISOString()}`);
  console.log(`${bar}`);

  await initStorageFiles();

  const skipList = await getSkipList();
  console.log(`  Skip list: ${skipList.length} companies`);

  await getLabelId('Outreach Sent').catch(() => {});

  const steps = {};
  steps.replies   = await detectReplies();
  steps.followUps = await sendFollowUps();
  steps.outreach  = await sendInitialOutreach(skipList);
  steps.research  = await researchNewProspects(skipList);
  await writeSummary(steps);

  console.log(`\n✅  Run complete.\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy server routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Lu Dashboard Proxy', authed: !!tokenStore.access_token }));

app.get('/auth/login', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.labels',
    'https://www.googleapis.com/auth/calendar.readonly',
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
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }),
    });
    const tokens = await response.json();
    if (tokens.error) return res.send(`<h2>Token error: ${tokens.error_description}</h2>`);
    tokenStore = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry: Date.now() + (tokens.expires_in * 1000) };
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>&#10003; Gmail &amp; Calendar connected!</h2><p>You can close this tab and go back to your dashboard.</p><script>if(window.opener){window.opener.postMessage('auth_success','*');window.close();}</script></body></html>`);
  } catch (err) { res.send(`<h2>Error: ${err.message}</h2>`); }
});

async function getValidAccessToken() {
  if (!tokenStore.access_token) throw new Error('NOT_AUTHENTICATED');
  if (Date.now() > tokenStore.expiry - 60000) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: tokenStore.refresh_token, grant_type: 'refresh_token' }),
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

// ── Agent routes ──────────────────────────────────────────────────────────────

let agentRunning = false;

// POST /run-agent — called by cron-job.org at 7am Europe/London
// Set CRON_SECRET on Render and configure cron-job.org to send:
//   Authorization: Bearer <your-secret>
app.post('/run-agent', async (req, res) => {
  if (CRON_SECRET) {
    const auth = (req.headers.authorization || '').trim();
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  if (agentRunning) {
    return res.status(409).json({ error: 'Agent already running', started: true });
  }
  agentRunning = true;
  // Respond immediately so cron-job.org doesn't time out waiting for the full run
  res.json({ status: 'started', timestamp: new Date().toISOString() });
  runAgent()
    .catch(err => console.error('Agent run error:', err))
    .finally(() => { agentRunning = false; });
});

// GET /agent/status — is the agent currently running?
app.get('/agent/status', (req, res) => {
  res.json({ running: agentRunning });
});

// GET /agent/summary — today's run summary (for the dashboard)
app.get('/agent/summary', async (req, res) => {
  try {
    const data = await fs.readFile(SUMMARY_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ date: null, message: 'No summary yet — agent has not run.' });
    res.status(500).json({ error: err.message });
  }
});

// GET /agent/prospects — full prospect list
app.get('/agent/prospects', async (req, res) => {
  try { res.json(await getProspects()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /agent/logs — run history
app.get('/agent/logs', async (req, res) => {
  try { res.json(await getLogs()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lu Dashboard Proxy running on port ${PORT}`));
