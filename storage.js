/**
 * File-based storage replacing Supabase.
 *
 * prospects.json   — array of prospect objects (same schema as before)
 * agent-logs.json  — array of daily run log entries
 *
 * All writes are atomic: data is written to a .tmp file first, then
 * renamed into place. On POSIX (macOS, Linux) rename() is guaranteed
 * atomic on the same filesystem, so a crash mid-write can never
 * produce a truncated or partially-written JSON file.
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const PROSPECTS_FILE = path.join(__dirname, 'prospects.json');
const LOGS_FILE = path.join(__dirname, 'agent-logs.json');
const SKIP_LIST_FILE = path.join(__dirname, 'skip-list.json');

// ── Low-level helpers ─────────────────────────────────────────────────────────

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
  await fs.rename(tmp, filePath); // atomic on POSIX
}

// ── Prospects ─────────────────────────────────────────────────────────────────

async function getProspects() {
  return readJSON(PROSPECTS_FILE, []);
}

async function saveProspects(prospects) {
  await atomicWrite(PROSPECTS_FILE, prospects);
}

/**
 * Insert a new prospect. Generates id and created_at automatically.
 * Returns the saved prospect object.
 */
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

/**
 * Update a single prospect by id. Merges updates into the existing record.
 * Throws if the id is not found.
 */
async function updateProspect(id, updates) {
  const prospects = await getProspects();
  const idx = prospects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Prospect not found: ${id}`);
  prospects[idx] = { ...prospects[idx], ...updates };
  await saveProspects(prospects);
  return prospects[idx];
}

/**
 * Update every prospect where predicateFn(prospect) returns true.
 * Returns the number of records updated.
 */
async function bulkUpdateProspects(predicateFn, updates) {
  const prospects = await getProspects();
  let count = 0;
  for (const p of prospects) {
    if (predicateFn(p)) {
      Object.assign(p, updates);
      count++;
    }
  }
  await saveProspects(prospects);
  return count;
}

// ── Skip List ─────────────────────────────────────────────────────────────────

/** Returns the array of company names from skip-list.json. */
async function getSkipList() {
  const data = await readJSON(SKIP_LIST_FILE, { companies: [] });
  return Array.isArray(data.companies) ? data.companies : [];
}

// ── Logs ──────────────────────────────────────────────────────────────────────

async function getLogs() {
  return readJSON(LOGS_FILE, []);
}

async function appendLog(data) {
  const logs = await getLogs();
  const entry = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ...data,
  };
  logs.push(entry);
  await atomicWrite(LOGS_FILE, logs);
  return entry;
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Ensure both data files exist. Called once at startup.
 */
async function initFiles() {
  for (const [file, def] of [
    [PROSPECTS_FILE, []],
    [LOGS_FILE, []],
    [SKIP_LIST_FILE, { note: 'Add company names here to skip them during outreach.', companies: [] }],
  ]) {
    try {
      await fs.access(file);
    } catch {
      await atomicWrite(file, def);
      console.log(`  Created ${path.basename(file)}`);
    }
  }
}

module.exports = {
  getProspects,
  saveProspects,
  insertProspect,
  updateProspect,
  bulkUpdateProspects,
  getLogs,
  appendLog,
  getSkipList,
  initFiles,
  PROSPECTS_FILE,
  LOGS_FILE,
  SKIP_LIST_FILE,
};
