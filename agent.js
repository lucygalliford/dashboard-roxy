/**
 * Lucy Galliford — Automated Brand Deal Outreach Agent
 *
 * Runs every morning at 7:00 AM (Europe/London) via node-cron.
 * Manual trigger: node agent.js --run-now
 *
 * Storage: prospects.json + agent-logs.json (local files, atomic writes)
 *
 * Daily run order:
 *   1. Detect replies (mark replied/bounced, apply Gmail labels)
 *   2. Send follow-ups (follow_up_1, follow_up_2, mark no_response)
 *   3. Send initial outreach to researched prospects (cap: 10/day)
 *   4. Research 5 new prospects via Claude + verify email via Prospeo
 *   5. Write daily-summary.json + append to agent-logs.json
 */

'use strict';

require('dotenv').config();
const cron = require('node-cron');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const storage = require('./storage');

// ── Config ────────────────────────────────────────────────────────────────────

const MY_EMAIL = process.env.MY_EMAIL;
const MY_NAME = process.env.MY_NAME;
const MEDIA_KIT_URL = process.env.MEDIA_KIT_URL;
const DAILY_OUTREACH_CAP = 10;
const FOLLOW_UP_1_AFTER_DAYS = 4;
const FOLLOW_UP_2_AFTER_DAYS = 7;  // days after follow_up_1
const NO_RESPONSE_AFTER_DAYS = 7;  // days after follow_up_2

// When true: emails go to Gmail Drafts, no prospect statuses are updated
const DRY_RUN = process.argv.includes('--dry-run');
const dr = s => `  [DRY RUN] ${s}`; // log prefix helper

// ── Clients ───────────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function firstName(fullName) {
  return (fullName || '').split(' ')[0];
}

/** Normalise a company name for fuzzy matching (lowercase, alphanumeric only). */
function normaliseName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns true if companyName fuzzy-matches any entry in skipList.
 * Matches on equality or substring containment in either direction,
 * so "Lume Cube" matches "lumecube" and vice-versa.
 */
function isSkipListed(companyName, skipList) {
  const norm = normaliseName(companyName);
  return skipList.some(s => {
    const sn = normaliseName(s);
    return norm === sn || norm.includes(sn) || sn.includes(norm);
  });
}

/**
 * Search Gmail for any thread involving this company in the last 12 months.
 * Returns true if a thread is found (indicating an existing relationship).
 * Fails open on errors — never blocks an email due to a Gmail API hiccup.
 */
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
  } catch {
    return false;
  }
}

// ── Gmail Helpers ─────────────────────────────────────────────────────────────

/** In-memory cache so we only call labels.list once per run. */
let _labelCache = null;

async function getLabelId(name) {
  if (!_labelCache) {
    const res = await gmail.users.labels.list({ userId: 'me' });
    _labelCache = {};
    for (const l of res.data.labels || []) _labelCache[l.name] = l.id;
  }
  if (!_labelCache[name]) {
    // Create on-demand if missing (shouldn't happen after setup.js)
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
  await gmail.users.messages.modify({
    userId: 'me', id: messageId,
    requestBody: { addLabelIds: [id] },
  });
}

async function removeLabel(messageId, labelName) {
  const id = await getLabelId(labelName);
  await gmail.users.messages.modify({
    userId: 'me', id: messageId,
    requestBody: { removeLabelIds: [id] },
  });
}

// ── HTML email helpers ────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert plain text paragraphs (double-newline separated) to <p> blocks. */
function textToHtml(text) {
  return text
    .split(/\n\n+/)
    .map(para => {
      const inner = para.split('\n').map(escapeHtml).join('<br>');
      return `<p style="margin:0 0 14px 0">${inner}</p>`;
    })
    .join('\n');
}

// Computed once at startup from env
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
        <a href="${MEDIA_KIT_URL}" style="color:#1a1a1a;text-decoration:none">📎 View my Media Kit</a>
      </p>` : ''}
    </td>
  </tr>
</table>`;

const PLAIN_TEXT_SIGNATURE = [
  '--',
  'Lucy Galliford | Travel Filmmaker',
  '+44 (0) 7772 214020 | Available Worldwide',
  'create@lucygalliford.com | www.lucygalliford.com',
  MEDIA_KIT_URL ? `Media Kit: ${MEDIA_KIT_URL}` : null,
].filter(Boolean).join('\n');

/**
 * Build a multipart/alternative MIME payload (plain text + HTML).
 * Gmail (and every modern client) renders the HTML part; plain text is the
 * fallback for clients that strip HTML.
 * Providing threadId causes Gmail to append to that thread rather than
 * creating a new one — essential for follow-ups appearing inline.
 */
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

  const raw = Buffer.from(mime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const payload = { raw };
  if (threadId) payload.threadId = threadId;
  return payload;
}

/**
 * Send with up to 3 retries on 429 rate-limit responses.
 * Returns the sent Message resource ({ id, threadId }).
 */
async function sendEmail(payload, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: payload });
      return res.data;
    } catch (err) {
      const isRateLimit = err.code === 429 || err.status === 429 ||
        err.message?.toLowerCase().includes('rate limit');
      if (isRateLimit && attempt < retries - 1) {
        console.log('    ⏳ Gmail rate limited — waiting 60s...');
        await sleep(60_000);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Dry-run alternative to sendEmail — saves to Gmail Drafts instead.
 * Returns { id, threadId } matching the shape sendEmail returns.
 */
async function createDraft(payload) {
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: payload.raw,
        ...(payload.threadId && { threadId: payload.threadId }),
      },
    },
  });
  return { id: res.data.message.id, threadId: res.data.message.threadId };
}

/**
 * Returns the first non-me message in a thread, or null if none exists.
 * Also flags delivery-failure (bounce) messages.
 */
async function getFirstReplyInThread(threadId) {
  let thread;
  try {
    thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From'],
    });
  } catch {
    return null;
  }

  for (const msg of thread.data.messages || []) {
    const fromHeader = (msg.payload.headers || []).find(h => h.name.toLowerCase() === 'from');
    if (!fromHeader) continue;
    const from = fromHeader.value.toLowerCase();
    if (from.includes(MY_EMAIL.toLowerCase())) continue; // our own message

    const isBounce =
      from.includes('mailer-daemon') ||
      from.includes('postmaster') ||
      from.includes('mail delivery') ||
      from.includes('delivery status');

    return { messageId: msg.id, isBounce };
  }
  return null;
}

// ── Claude Helpers ────────────────────────────────────────────────────────────

// Cached system context — stays warm across the multiple Claude calls in one run
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

// ── Hunter.io Helpers ─────────────────────────────────────────────────────────

/**
 * Returns a verified email string via Hunter's email-finder endpoint, or null.
 * Only "valid" status is accepted — "accept_all" and "unknown" are skipped
 * to avoid sending to addresses that can't be individually confirmed.
 */
async function findVerifiedEmail(fullName, companyDomain) {
  const [firstName, ...rest] = fullName.trim().split(' ');
  const lastName = rest.join(' ');

  try {
    const res = await axios.get('https://api.hunter.io/v2/email-finder', {
      params: {
        domain: companyDomain,
        first_name: firstName,
        last_name: lastName,
        api_key: process.env.HUNTER_API_KEY,
      },
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
    const detail = err.response?.data?.errors?.[0]?.details || err.message;
    console.warn(`    Hunter error (${fullName} @ ${companyDomain}): ${detail}`);
    return null;
  }
}

// ── Step 1: Detect Replies ────────────────────────────────────────────────────

async function detectReplies() {
  console.log('\n📬  Step 1 — Detecting replies...');
  const summary = { repliesDetected: 0, repliesFound: [], errors: [] };

  const all = await storage.getProspects();
  const prospects = all.filter(p =>
    p.thread_id &&
    ['outreach_sent', 'follow_up_1_sent', 'follow_up_2_sent'].includes(p.status)
  );

  for (const p of prospects) {
    try {
      const reply = await getFirstReplyInThread(p.thread_id);
      if (!reply) continue;

      if (reply.isBounce) {
        if (!DRY_RUN) await storage.updateProspect(p.id, { status: 'bounced' });
        console.log(DRY_RUN ? dr(`Would mark bounced — ${p.company_name}`) : `  ↩  Bounce — ${p.company_name}`);
        continue;
      }

      // Genuine reply
      const now = new Date().toISOString();
      if (!DRY_RUN) {
        await storage.updateProspect(p.id, { status: 'replied', replied_at: now });
        if (p.gmail_message_id) {
          await applyLabel(p.gmail_message_id, '⭐ Replied — Needs Attention').catch(() => {});
          await removeLabel(p.gmail_message_id, 'Outreach Sent').catch(() => {});
        }
      }

      summary.repliesDetected++;
      summary.repliesFound.push({ company: p.company_name, contact: p.contact_name, repliedAt: now });
      console.log(DRY_RUN
        ? dr(`Would mark replied — ${p.company_name} (${p.contact_name})`)
        : `  ✅  Reply from ${p.company_name} (${p.contact_name})`);
    } catch (err) {
      console.error(`  ⚠️  Reply check failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`Reply check ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.repliesDetected} new replies detected.`);
  return summary;
}

// ── Step 2: Send Follow-ups ───────────────────────────────────────────────────

async function sendFollowUps() {
  console.log('\n📤  Step 2 — Sending follow-ups...');
  const summary = { followUpsSent: 0, followUpsSentList: [], errors: [] };
  const now = new Date();

  // ── Mark no_response for follow_up_2 sent 7+ days ago ──────────────────────
  const noResponseCutoff = daysAgo(NO_RESPONSE_AFTER_DAYS);
  if (!DRY_RUN) {
    await storage.bulkUpdateProspects(
      p => p.status === 'follow_up_2_sent' && p.follow_up_2_sent_at < noResponseCutoff,
      { status: 'no_response' }
    );
  } else {
    const wouldExpire = (await storage.getProspects()).filter(
      p => p.status === 'follow_up_2_sent' && p.follow_up_2_sent_at < noResponseCutoff
    );
    if (wouldExpire.length) console.log(dr(`Would mark ${wouldExpire.length} prospect(s) as no_response`));
  }

  // ── Follow-up 2 (final chase) ───────────────────────────────────────────────
  // Fresh read so no_response batch above is already excluded
  const fu2Cutoff = daysAgo(FOLLOW_UP_2_AFTER_DAYS);
  const fu2List = (await storage.getProspects()).filter(p =>
    p.status === 'follow_up_1_sent' && p.follow_up_1_sent_at < fu2Cutoff
  );

  for (const p of fu2List) {
    try {
      if (p.thread_id) {
        const reply = await getFirstReplyInThread(p.thread_id);
        if (reply && !reply.isBounce) continue; // genuine reply received — skip
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

      const payload = buildGmailPayload({
        to: p.contact_email,
        subject: `Re: ${p.company_name} x Lucy Galliford`,
        body,
        threadId: p.thread_id,
      });

      if (DRY_RUN) {
        await createDraft(payload);
        console.log(dr(`Draft created — Follow-up 2 → ${p.company_name}`));
      } else {
        await sendEmail(payload);
        await storage.updateProspect(p.id, {
          status: 'follow_up_2_sent',
          follow_up_2_sent_at: now.toISOString(),
        });
        console.log(`  ✉️   Follow-up 2 → ${p.company_name}`);
      }

      summary.followUpsSent++;
      summary.followUpsSentList.push({ company: p.company_name, status: 'follow_up_2_sent' });
      await sleep(2000);
    } catch (err) {
      console.error(`  ⚠️  FU2 failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`FU2 ${p.company_name}: ${err.message}`);
    }
  }

  // ── Follow-up 1 ────────────────────────────────────────────────────────────
  const fu1Cutoff = daysAgo(FOLLOW_UP_1_AFTER_DAYS);
  const fu1List = (await storage.getProspects()).filter(p =>
    p.status === 'outreach_sent' && p.outreach_sent_at < fu1Cutoff
  );

  for (const p of fu1List) {
    try {
      if (p.thread_id) {
        const reply = await getFirstReplyInThread(p.thread_id);
        if (reply && !reply.isBounce) continue; // genuine reply already received
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

      const payload = buildGmailPayload({
        to: p.contact_email,
        subject: `Re: ${p.company_name} x Lucy Galliford`,
        body,
        threadId: p.thread_id,
      });

      if (DRY_RUN) {
        await createDraft(payload);
        console.log(dr(`Draft created — Follow-up 1 → ${p.company_name}`));
      } else {
        await sendEmail(payload);
        await storage.updateProspect(p.id, {
          status: 'follow_up_1_sent',
          follow_up_1_sent_at: now.toISOString(),
        });
        console.log(`  ✉️   Follow-up 1 → ${p.company_name}`);
      }

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

// ── Step 3: Send Initial Outreach ─────────────────────────────────────────────

async function sendInitialOutreach(skipList) {
  console.log('\n🚀  Step 3 — Sending initial outreach...');
  const summary = { emailsSent: 0, outreachSentList: [], errors: [] };

  const allProspects = await storage.getProspects();
  const prospects = allProspects
    .filter(p => p.status === 'researched')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, DAILY_OUTREACH_CAP);

  if (!prospects.length) {
    console.log('  → No prospects ready for outreach.');
    return summary;
  }

  for (const p of prospects) {
    if (summary.emailsSent >= DAILY_OUTREACH_CAP) break;

    try {
      // ── Safety checks (must pass all three before any email is sent) ──────
      if (isSkipListed(p.company_name, skipList)) {
        console.log(`  ⛔  ${p.company_name} — on skip list, skipping`);
        continue;
      }

      const activeDuplicate = allProspects.find(r =>
        r.id !== p.id &&
        r.status !== 'no_response' &&
        (normaliseName(r.company_name) === normaliseName(p.company_name) ||
         r.contact_email === p.contact_email)
      );
      if (activeDuplicate) {
        console.log(`  ⛔  ${p.company_name} — already in pipeline (${activeDuplicate.status}), skipping`);
        continue;
      }

      const domain = p.contact_email.split('@')[1];
      if (await hasGmailHistory(p.company_name, domain)) {
        console.log(`  ⛔  ${p.company_name} — skipped — existing relationship`);
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────

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

      const payload = buildGmailPayload({
        to: p.contact_email,
        subject: `${p.company_name} x Lucy Galliford`,
        body,
      });

      if (DRY_RUN) {
        await createDraft(payload);
        console.log(dr(`Draft created — Outreach → ${p.contact_name} at ${p.company_name}`));
      } else {
        const sent = await sendEmail(payload);
        const now = new Date().toISOString();
        await applyLabel(sent.id, 'Outreach Sent').catch(err =>
          console.warn(`    Label error: ${err.message}`)
        );
        await storage.updateProspect(p.id, {
          status: 'outreach_sent',
          outreach_sent_at: now,
          thread_id: sent.threadId,
          gmail_message_id: sent.id,
        });
        console.log(`  ✉️   Outreach → ${p.contact_name} at ${p.company_name}`);
      }

      summary.emailsSent++;
      summary.outreachSentList.push({
        company: p.company_name,
        contact: p.contact_name,
        email: p.contact_email,
      });
      await sleep(2000); // light throttle between sends
    } catch (err) {
      console.error(`  ⚠️  Outreach failed for ${p.company_name}: ${err.message}`);
      summary.errors.push(`Outreach ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.emailsSent} outreach email(s) sent.`);
  return summary;
}

// ── Step 4: Research New Prospects ───────────────────────────────────────────

const CATEGORY_BY_DOW = {
  0: 'mixed',    // Sunday
  1: 'tourism',  // Monday
  2: 'gear',     // Tuesday
  3: 'airline',  // Wednesday
  4: 'tech',     // Thursday
  5: 'clothing', // Friday
  6: 'mixed',    // Saturday
};

async function researchNewProspects(skipList) {
  console.log('\n🔍  Step 4 — Researching new prospects...');
  const summary = { prospectsResearched: 0, newProspectsList: [], errors: [] };

  const category = CATEGORY_BY_DOW[new Date().getDay()];
  console.log(`  → Today's category: ${category}`);

  // Ask Claude to surface 5 prospects from its training knowledge.
  // This is based on known brands, not live search — it finds established
  // companies with real partnership programmes that are a strong fit for Lucy.
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

  // Load once for dedup checks; insertProspect re-reads internally but that's fine at this scale
  const existing = await storage.getProspects();

  for (const p of (prospects || []).slice(0, 5)) {
    try {
      // Skip list check first — before spending an API call on email lookup
      if (isSkipListed(p.company_name, skipList)) {
        console.log(`  ⛔  ${p.company_name} — on skip list, skipping`);
        continue;
      }

      console.log(`  🔎  ${p.company_name} (${p.company_domain}) — looking up ${p.contact_name}...`);

      const email = await findVerifiedEmail(p.contact_name, p.company_domain);

      if (!email) {
        console.log(`  ⚠️   No verified email for ${p.contact_name} at ${p.company_domain} — skipping`);
        continue;
      }

      // Deduplicate: company OR email already in pipeline (any non-no_response status)
      const inPipeline = existing.some(r =>
        r.status !== 'no_response' &&
        (normaliseName(r.company_name) === normaliseName(p.company_name) ||
         r.contact_email === email)
      );
      if (inPipeline) {
        console.log(`  ↩   ${p.company_name} already in pipeline — skipping`);
        continue;
      }

      // Gmail history check
      const domain = email.split('@')[1];
      if (await hasGmailHistory(p.company_name, domain)) {
        console.log(`  ⛔  ${p.company_name} — skipped — existing relationship`);
        continue;
      }

      await storage.insertProspect({
        company_name: p.company_name,
        contact_name: p.contact_name,
        contact_email: email,
        category: p.category,
        research_notes: `${p.why_fit}\n\n${p.research_notes}`,
      });

      summary.prospectsResearched++;
      summary.newProspectsList.push({
        company: p.company_name,
        category: p.category,
        contact: p.contact_name,
      });
      console.log(`  ✅  Added ${p.contact_name} at ${p.company_name} (${email})`);
    } catch (err) {
      console.error(`  ⚠️  Error processing ${p.company_name}: ${err.message}`);
      summary.errors.push(`Research ${p.company_name}: ${err.message}`);
    }
  }

  console.log(`  → ${summary.prospectsResearched} new prospect(s) saved.`);
  return summary;
}

// ── Step 5: Write Summary ─────────────────────────────────────────────────────

async function writeSummary(steps) {
  const today = new Date().toISOString().split('T')[0];

  const all = await storage.getProspects();
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

  await fs.writeFile(
    path.join(__dirname, 'daily-summary.json'),
    JSON.stringify(summary, null, 2)
  );

  const allErrors = [
    ...(steps.replies?.errors || []),
    ...(steps.followUps?.errors || []),
    ...(steps.outreach?.errors || []),
    ...(steps.research?.errors || []),
  ].join(' | ');

  await storage.appendLog({
    run_date: today,
    dry_run: DRY_RUN ? true : undefined,
    prospects_researched: steps.research?.prospectsResearched || 0,
    emails_sent: DRY_RUN ? 0 : (steps.outreach?.emailsSent || 0),
    drafts_created: DRY_RUN ? (steps.outreach?.emailsSent || 0) + (steps.followUps?.followUpsSent || 0) : undefined,
    follow_ups_sent: DRY_RUN ? 0 : (steps.followUps?.followUpsSent || 0),
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function runAgent() {
  const bar = '═'.repeat(55);
  console.log(`\n${bar}`);
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Lucy's Outreach Agent  —  ${new Date().toISOString()}`);
    console.log(`  Emails → Gmail Drafts only. No statuses will be updated.`);
  } else {
    console.log(`  Lucy's Outreach Agent  —  ${new Date().toISOString()}`);
  }
  console.log(`${bar}`);

  await storage.initFiles();

  // Load skip list once — reloaded fresh each run so edits to skip-list.json
  // take effect without restarting the agent
  const skipList = await storage.getSkipList();
  console.log(`  Skip list: ${skipList.length} companies`);

  // Pre-warm Gmail label cache
  await getLabelId('Outreach Sent').catch(() => {});

  const steps = {};

  steps.replies = await detectReplies();
  steps.followUps = await sendFollowUps();
  steps.outreach = await sendInitialOutreach(skipList);
  steps.research = await researchNewProspects(skipList);
  await writeSummary(steps);

  console.log(`\n✅  Run complete.\n`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

if (process.argv.includes('--run-now') || DRY_RUN) {
  runAgent().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
} else {
  // 7:00 AM London time every day
  cron.schedule('0 7 * * *', () => {
    runAgent().catch(err => console.error('Agent run error:', err));
  }, { timezone: 'Europe/London' });

  console.log("🕐  Lucy's Outreach Agent is running.");
  console.log('    Scheduled:  7:00 AM Europe/London daily.');
  console.log('    Run now:    node agent.js --run-now');
  console.log('    Dry run:    node agent.js --dry-run\n');
}
