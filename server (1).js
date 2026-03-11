/**
 * =====================================================
 *   HABUILD COMMUNITY TRACKER — Backend Server
 *   Powered by Maytapi WhatsApp API
 *   Supports 21 phones / 600+ communities
 * =====================================================
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // Get these from https://console.maytapi.com/settings/token
  MAYTAPI_PRODUCT_ID: process.env.MAYTAPI_PRODUCT_ID || 'bf6a3081-7fec-4509-aabd-60ba0200e883',
  MAYTAPI_TOKEN:      process.env.MAYTAPI_TOKEN      || 'f944cd30-b896-41fd-b550-9a40789671f5',
  MAYTAPI_BASE:       'https://api.maytapi.com/api',

  // ⚠️ Add ALL 21 of your phone IDs here
  // Find them at: https://console.maytapi.com → Phones page
  // OR call GET /listPhones after setting token above
  PHONE_IDS: (process.env.PHONE_IDS || '').split(',').filter(Boolean),
  // Example: PHONE_IDS=12345,12346,12347 node server.js

  WARN_LIMIT:    1600,  // Early warning alert
  MAX_LIMIT:     1800,  // Full alert — needs new link

  // Your WhatsApp number to receive alerts (include country code, no +)
  // This should be one of your 21 phones OR a manager's personal number
  ALERT_PHONE_ID: process.env.ALERT_PHONE_ID || '134920',
  ALERT_NUMBER:   process.env.ALERT_NUMBER   || '91XXXXXXXXXX', // no + sign

  PORT:      process.env.PORT || 3000,
  DATA_FILE: path.join(__dirname, 'data', 'communities.json'),
};

// ─── DATA STORE ───────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (!fs.existsSync(path.dirname(CONFIG.DATA_FILE))) {
      fs.mkdirSync(path.dirname(CONFIG.DATA_FILE), { recursive: true });
    }
    if (!fs.existsSync(CONFIG.DATA_FILE)) {
      return { communities: {}, history: [], alerts_sent: {}, phones: [] };
    }
    return JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
  } catch {
    return { communities: {}, history: [], alerts_sent: {}, phones: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

// ─── MAYTAPI HELPERS ──────────────────────────────────────────────────────────
const maytapiHeaders = () => ({
  'x-maytapi-key': CONFIG.MAYTAPI_TOKEN,
  'Content-Type':  'application/json',
});

const apiUrl = (path) =>
  `${CONFIG.MAYTAPI_BASE}/${CONFIG.MAYTAPI_PRODUCT_ID}${path}`;

// Auto-discover all phone IDs from the account if not manually set
async function discoverPhones() {
  try {
    const res = await axios.get(
      `${CONFIG.MAYTAPI_BASE}/${CONFIG.MAYTAPI_PRODUCT_ID}/listPhones`,
      { headers: maytapiHeaders() }
    );

    // Debug: show raw response shape
    console.log(`🔍 listPhones raw type:`, typeof res.data, Array.isArray(res.data) ? 'array' : (res.data ? Object.keys(res.data).slice(0,5).join(',') : 'null'));

    // Maytapi can wrap response in different ways
    let rawPhones = [];
    if (Array.isArray(res.data)) {
      rawPhones = res.data;
    } else if (Array.isArray(res.data && res.data.data)) {
      rawPhones = res.data.data;
    } else if (Array.isArray(res.data && res.data.phones)) {
      rawPhones = res.data.phones;
    } else {
      console.warn('⚠️  Unexpected listPhones response:', JSON.stringify(res.data).slice(0, 300));
      rawPhones = [];
    }

    db.phones = rawPhones.map(p => {
      // Debug: log every field so we can see the actual phone ID
      console.log('🔍 Phone object:', JSON.stringify(p));
      return {
        id:     String(p.phone_id ?? p.id ?? p._id ?? ''),
        number: p.number || p.phone || '',
        name:   p.name   || `Phone ${p.phone_id || p.id}`,
        status: p.status || 'unknown',
      };
    });
    saveData(db);

    if (CONFIG.PHONE_IDS.length === 0) {
      CONFIG.PHONE_IDS = db.phones.map(p => p.id);
    }
    console.log(`📱 Found ${db.phones.length} phones: ${db.phones.map(p => p.number || p.id).join(', ')}`);
    return db.phones;
  } catch (err) {
    console.error('❌ Error discovering phones:', err.response?.data || err.message);
    return [];
  }
}

// Fetch all groups for ONE phone
async function fetchGroupsForPhone(phoneId) {
  try {
    const res = await axios.get(
      apiUrl(`/${phoneId}/getGroups`),
      { headers: maytapiHeaders() }
    );

    // Debug: log raw response shape once
    console.log(`🔍 Phone ${phoneId} raw response type:`, typeof res.data, Array.isArray(res.data) ? 'array' : (res.data ? Object.keys(res.data).join(',') : 'null'));

    // Maytapi can return several shapes depending on version:
    //   { success: true, data: [...] }   <- most common
    //   { conversations: [...] }
    //   [ ... ]                          <- plain array (older)
    let groups = [];
    if (Array.isArray(res.data)) {
      groups = res.data;
    } else if (Array.isArray(res.data && res.data.data)) {
      groups = res.data.data;
    } else if (Array.isArray(res.data && res.data.conversations)) {
      groups = res.data.conversations;
    } else {
      console.warn(`⚠️  Unexpected getGroups shape for phone ${phoneId}:`, JSON.stringify(res.data).slice(0, 300));
      groups = [];
    }

    return groups.map(g => ({ ...g, _phone_id: phoneId }));
  } catch (err) {
    console.error(`❌ Error fetching groups for phone ${phoneId}:`, err.response?.data || err.message);
    return [];
  }
}

// Fetch groups across ALL 21 phones in parallel
async function fetchAllGroupsAllPhones() {
  const phoneIds = CONFIG.PHONE_IDS;
  if (!phoneIds.length) {
    console.warn('⚠️  No phone IDs configured. Auto-discovering...');
    await discoverPhones();
  }

  console.log(`🔄 Fetching groups from ${CONFIG.PHONE_IDS.length} phones...`);

  // Fetch all phones in parallel (but with slight delay to avoid rate limits)
  const results = await Promise.allSettled(
    CONFIG.PHONE_IDS.map((phoneId, i) =>
      new Promise(resolve =>
        setTimeout(() => fetchGroupsForPhone(phoneId).then(resolve), i * 300)
      )
    )
  );

  const allGroups = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      allGroups.push(...result.value);
    } else {
      console.error(`❌ Phone ${CONFIG.PHONE_IDS[i]} failed:`, result.reason);
    }
  });

  return allGroups;
}

// Send WhatsApp alert message via Maytapi
async function sendWAAlert(message) {
  try {
    await axios.post(
      apiUrl(`/${CONFIG.ALERT_PHONE_ID}/sendMessage`),
      {
        to_number: CONFIG.ALERT_NUMBER,
        type:      'text',
        message,
      },
      { headers: maytapiHeaders() }
    );
    console.log('✅ WhatsApp alert sent!');
  } catch (err) {
    console.error('❌ Failed to send WA alert:', err.response?.data || err.message);
  }
}

// ─── ALERT LOGIC ──────────────────────────────────────────────────────────────
async function checkAndAlert(groupId, groupName, count, phoneId) {
  const alertKey_max  = `${groupId}_max`;
  const alertKey_warn = `${groupId}_warn`;
  const phoneInfo     = db.phones.find(p => p.id === String(phoneId));
  const phoneLabel    = phoneInfo?.number || phoneInfo?.name || `Phone ${phoneId}`;
  const now           = new Date().toISOString();

  if (count >= CONFIG.MAX_LIMIT) {
    if (!db.alerts_sent[alertKey_max]) {
      const msg =
        `🚨 *URGENT — Community Full!*\n\n` +
        `*${groupName}*\n` +
        `Members: *${count}/${CONFIG.MAX_LIMIT}*\n` +
        `Phone: ${phoneLabel}\n\n` +
        `⚠️ Please create a NEW WhatsApp group and share the new invite link immediately!\n\n` +
        `_Habuild Community Tracker — ${new Date().toLocaleString('en-IN')}_`;
      await sendWAAlert(msg);
      db.alerts_sent[alertKey_max] = now;
      saveData(db);
      console.log(`🚨 FULL ALERT sent for: ${groupName} (${count} members) on ${phoneLabel}`);
    }
  } else {
    delete db.alerts_sent[alertKey_max];
  }

  if (count >= CONFIG.WARN_LIMIT && count < CONFIG.MAX_LIMIT) {
    if (!db.alerts_sent[alertKey_warn]) {
      const msg =
        `⚠️ *Community Approaching Limit*\n\n` +
        `*${groupName}*\n` +
        `Members: *${count}/${CONFIG.MAX_LIMIT}*\n` +
        `Slots remaining: *${CONFIG.MAX_LIMIT - count}*\n` +
        `Phone: ${phoneLabel}\n\n` +
        `Please prepare a new group link soon.\n\n` +
        `_Habuild Community Tracker — ${new Date().toLocaleString('en-IN')}_`;
      await sendWAAlert(msg);
      db.alerts_sent[alertKey_warn] = now;
      saveData(db);
      console.log(`⚠️  WARN ALERT sent for: ${groupName} (${count} members) on ${phoneLabel}`);
    }
  } else {
    delete db.alerts_sent[alertKey_warn];
  }
}

// ─── SYNC ALL GROUPS ──────────────────────────────────────────────────────────
async function syncAllGroups() {
  console.log('\n🔄 Starting full sync across all phones...');
  const allGroups = await fetchAllGroupsAllPhones();

  // Deduplication: for groups with same name across phones, keep highest count
  // (Same community can be admin'd from multiple phones)
  const nameMap = {};
  for (const g of allGroups) {
    // Maytapi group fields: id (conversation_id), name, participants (array)
    const name    = (g.name || g.subject || 'Unnamed Group').trim();
    const count   = g.participants?.length ?? g.participants_count ?? 0;
    const groupId = g.id || g.conversation_id;
    const phoneId = g._phone_id;

    if (count < 5) continue; // skip ghost/empty sub-groups

    const key = name.toLowerCase();
    if (!nameMap[key] || count > nameMap[key].count) {
      nameMap[key] = { id: groupId, name, count, phoneId, raw: g };
    }
  }

  const dedupedGroups = Object.values(nameMap);
  console.log(`   Raw groups: ${allGroups.length} → After dedup: ${dedupedGroups.length}`);

  for (const g of dedupedGroups) {
    const { id, name, count, phoneId } = g;
    const prev      = db.communities[id];
    const prevCount = prev?.count ?? count;
    const change    = count - prevCount;

    db.communities[id] = {
      id,
      name,
      count,
      phoneId:   String(phoneId),
      updatedAt: new Date().toISOString(),
      createdAt: prev?.createdAt || new Date().toISOString(),
    };

    if (change !== 0 || !prev) {
      db.history.unshift({
        groupId:   id,
        groupName: name,
        count,
        change,
        phoneId:   String(phoneId),
        date:      new Date().toISOString(),
      });
      if (db.history.length > 1000) db.history = db.history.slice(0, 1000);
    }

    await checkAndAlert(id, name, count, phoneId);
  }

  // Remove stale groups — BUT only if sync actually returned results
  // This prevents wiping all data when the API fails/returns 0 groups
  if (dedupedGroups.length > 0) {
    const activeIds = new Set(dedupedGroups.map(g => g.id));
    for (const id of Object.keys(db.communities)) {
      if (!activeIds.has(id)) {
        console.log(`   Removing stale: ${db.communities[id].name}`);
        delete db.communities[id];
      }
    }
  } else {
    console.log('   ⚠️ Sync returned 0 groups — keeping existing data (API may be down)');
  }

  saveData(db);
  console.log(`✅ Sync complete — ${dedupedGroups.length} unique communities across ${CONFIG.PHONE_IDS.length} phones.\n`);
  return dedupedGroups.length;
}

// ─── WEBHOOK (Real-time events from Maytapi) ──────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  const payload = req.body;

  // Maytapi webhook payload for group participant changes:
  // { type: 'message', conversation: '...@g.us', ... }
  // or { type: 'ack', ... }
  // Group participant events come as type: 'message' with subtype

  const type         = payload?.type;
  const conversation = payload?.conversation;
  const phoneId      = payload?.phone_id || payload?.phoneId;

  // Trigger resync on any group-related event
  if (conversation && conversation.includes('@g.us')) {
    console.log(`📡 Webhook: group event on phone ${phoneId} for ${conversation}`);

    // Fetch updated group info for this specific group
    try {
      if (phoneId) {
        const groups = await fetchGroupsForPhone(String(phoneId));
        const group  = groups.find(g => (g.id || g.conversation_id) === conversation);

        if (group) {
          const name    = (group.name || group.subject || db.communities[conversation]?.name || 'Unknown').trim();
          const count   = group.participants?.length ?? group.participants_count ?? 0;
          const prev    = db.communities[conversation];
          const change  = count - (prev?.count ?? count);
          const now     = new Date().toISOString();

          db.communities[conversation] = {
            ...(prev || {}),
            id:        conversation,
            name,
            count,
            phoneId:   String(phoneId),
            updatedAt: now,
            createdAt: prev?.createdAt || now,
          };

          if (change !== 0) {
            db.history.unshift({
              groupId:   conversation,
              groupName: name,
              count,
              change,
              phoneId:   String(phoneId),
              date:      now,
            });
            if (db.history.length > 1000) db.history = db.history.slice(0, 1000);
            console.log(`✅ Updated ${name}: ${count} members (${change > 0 ? '+' : ''}${change})`);
          }

          await checkAndAlert(conversation, name, count, phoneId);
          saveData(db);
        }
      }
    } catch (err) {
      console.error('❌ Webhook processing error:', err.message);
    }
  }
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Get all communities (with optional phone filter)
app.get('/api/communities', (req, res) => {
  let list = Object.values(db.communities).sort((a, b) => b.count - a.count);
  if (req.query.phone) {
    list = list.filter(c => c.phoneId === req.query.phone);
  }
  res.json({
    communities: list,
    limits:      { warn: CONFIG.WARN_LIMIT, max: CONFIG.MAX_LIMIT },
    phones:      db.phones,
    total:       list.length,
  });
});

// Get all phones
app.get('/api/phones', (req, res) => {
  res.json({ phones: db.phones });
});

// Get history (with optional phone/group filter)
app.get('/api/history', (req, res) => {
  let hist = db.history;
  if (req.query.phone) hist = hist.filter(h => h.phoneId === req.query.phone);
  if (req.query.group) hist = hist.filter(h => h.groupId === req.query.group);
  res.json({ history: hist.slice(0, 200) });
});

// Manual full sync
app.post('/api/sync', async (req, res) => {
  try {
    const count = await syncAllGroups();
    res.json({ success: true, synced: count, phones: CONFIG.PHONE_IDS.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update config at runtime
app.post('/api/config', (req, res) => {
  const { alertNumber, alertPhoneId, warnLimit, maxLimit } = req.body;
  if (alertNumber)  CONFIG.ALERT_NUMBER   = alertNumber.replace(/\D/g, '');
  if (alertPhoneId) CONFIG.ALERT_PHONE_ID = alertPhoneId;
  if (warnLimit)    CONFIG.WARN_LIMIT     = parseInt(warnLimit);
  if (maxLimit)     CONFIG.MAX_LIMIT      = parseInt(maxLimit);
  res.json({ success: true });
});

// Get members list for a specific group
app.get('/api/group/:groupId/members', async (req, res) => {
  const { groupId } = req.params;
  const community = db.communities[groupId];
  if (!community) return res.status(404).json({ error: 'Group not found' });

  try {
    const phoneId = community.phoneId;
    const groups  = await fetchGroupsForPhone(phoneId);
    const group   = groups.find(g => (g.id || g.conversation_id) === groupId);

    if (!group) return res.status(404).json({ error: 'Group not found on phone' });

    // Debug: log raw participant structure to understand Maytapi's fields
    const rawParticipants = group.participants || group.members || [];
    if (rawParticipants.length > 0) {
      console.log('🔍 Sample participant fields:', JSON.stringify(rawParticipants[0]));
    }

    const members = rawParticipants.map(p => {
      // Extract phone number — Maytapi uses id like "919876543210@s.whatsapp.net"
      const number = (p.id || p.number || p.phone || 'Unknown')
        .replace('@s.whatsapp.net','')
        .replace('@c.us','')
        .trim();

      // WhatsApp Community roles from Maytapi:
      // p.admin can be: "superadmin" (Community Owner), "admin" (Community Admin), or undefined/null (member)
      // p.rank can be: "owner", "admin", or undefined
      // p.role can be: "owner", "admin", "member"
      // p.type can be: "admin", "superadmin"
      const rawAdmin = p.admin || p.rank || p.role || p.type || '';

      let role = 'member';
      if (rawAdmin === 'superadmin' || rawAdmin === 'owner' || p.isSuperAdmin) {
        role = 'owner'; // Community Owner
      } else if (rawAdmin === 'admin' || p.isAdmin || p.is_admin) {
        role = 'admin'; // Community Admin
      }

      return {
        number,
        name: p.pushname || p.name || p.notify || p.verifiedName || '',
        role,
        rawAdmin, // keep raw value for debugging
      };
    });

    // Sort: owners first, then admins, then members
    members.sort((a, b) => {
      const order = { owner: 0, admin: 1, member: 2 };
      return (order[a.role] ?? 2) - (order[b.role] ?? 2);
    });

    res.json({
      group: {
        id:        groupId,
        name:      community.name,
        count:     members.length,
        phoneId:   community.phoneId,
        updatedAt: community.updatedAt,
      },
      members,
      owners:  members.filter(m => m.role === 'owner').length,
      admins:  members.filter(m => m.role === 'admin').length,
      total:   members.length,
    });
  } catch (err) {
    console.error('❌ Error fetching members:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:      'ok',
    communities: Object.keys(db.communities).length,
    phones:      CONFIG.PHONE_IDS.length,
    config: {
      warnLimit: CONFIG.WARN_LIMIT,
      maxLimit:  CONFIG.MAX_LIMIT,
    },
  });
});

// ─── MESSAGE SCHEDULER ────────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const SCHED_FILE = path.join(__dirname, 'data', 'scheduled.json');

function loadScheduled() {
  try {
    if (!fs.existsSync(SCHED_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8'));
  } catch { return []; }
}
function saveScheduled(msgs) {
  fs.writeFileSync(SCHED_FILE, JSON.stringify(msgs, null, 2));
}

let scheduledMessages = loadScheduled();

async function sendGroupMessage(phoneId, groupId, type, text, filePath, fileName) {
  try {
    if (type === 'text') {
      await axios.post(apiUrl(`/${phoneId}/sendMessage`), {
        to_number: groupId, type: 'text', message: text,
      }, { headers: maytapiHeaders() });
    } else {
      const fileBuffer = fs.readFileSync(filePath);
      const base64Data = fileBuffer.toString('base64');
      const ext = path.extname(fileName || '').toLowerCase();
      let mimeType = 'application/octet-stream';
      if (['.jpg','.jpeg'].includes(ext)) mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.mp4') mimeType = 'video/mp4';
      else if (ext === '.pdf') mimeType = 'application/pdf';
      else if (['.doc','.docx'].includes(ext)) mimeType = 'application/msword';
      else if (['.xls','.xlsx'].includes(ext)) mimeType = 'application/vnd.ms-excel';

      await axios.post(apiUrl(`/${phoneId}/sendMessage`), {
        to_number: groupId,
        type: type === 'document' ? 'document' : type,
        message: text || '',
        caption: text || '',
        ...(type === 'document' && { filename: fileName }),
        url: `data:${mimeType};base64,${base64Data}`,
      }, { headers: maytapiHeaders() });
    }
    return { success: true };
  } catch (err) {
    console.error(`❌ Send to ${groupId} failed:`, err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

async function executeScheduledMessage(msg) {
  console.log(`\n📤 Executing: "${(msg.text || '').slice(0, 50)}..."`);
  msg.status = 'sending';
  saveScheduled(scheduledMessages);

  let targetGroups = [];
  if (msg.target === 'all') {
    targetGroups = Object.values(db.communities);
  } else {
    const c = db.communities[msg.target];
    if (c) targetGroups = [c];
  }

  if (!targetGroups.length) {
    msg.status = 'failed'; msg.error = 'No target communities';
    saveScheduled(scheduledMessages); return;
  }

  console.log(`   Sending to ${targetGroups.length} communities...`);
  let sent = 0, failed = 0;

  for (const group of targetGroups) {
    const result = await sendGroupMessage(group.phoneId, group.id, msg.type, msg.text, msg.filePath, msg.fileName);
    if (result.success) { sent++; console.log(`   ✅ ${group.name}`); }
    else { failed++; console.log(`   ❌ ${group.name}: ${result.error}`); }
    await new Promise(r => setTimeout(r, 1000));
  }

  msg.status = failed === 0 ? 'sent' : (sent > 0 ? 'sent' : 'failed');
  msg.sentAt = new Date().toISOString();
  msg.sentCount = sent; msg.failCount = failed;
  msg.error = failed > 0 ? `${failed}/${targetGroups.length} failed` : null;
  saveScheduled(scheduledMessages);
  console.log(`✅ Done: ${sent} sent, ${failed} failed\n`);
}

// Create scheduled message
app.post('/api/scheduler', upload.single('file'), (req, res) => {
  try {
    const { type, target, scheduledAt, text, sendNow } = req.body;
    if (!type) return res.status(400).json({ success: false, error: 'Type required' });
    if (!scheduledAt) return res.status(400).json({ success: false, error: 'Time required' });

    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let targetName = 'All Communities';
    if (target !== 'all') { targetName = db.communities[target]?.name || target; }

    const msg = {
      id, type: type || 'text', target: target || 'all', targetName,
      scheduledAt, text: text || '',
      fileName: req.file?.originalname || null,
      filePath: req.file?.path || null,
      fileSize: req.file?.size || null,
      status: 'pending', createdAt: new Date().toISOString(),
      sentAt: null, sentCount: 0, failCount: 0, error: null,
    };

    scheduledMessages.unshift(msg);
    saveScheduled(scheduledMessages);

    if (sendNow === 'true') {
      executeScheduledMessage(msg);
      return res.json({ success: true, message: 'Sending now...', id });
    }

    console.log(`📅 Scheduled for ${new Date(scheduledAt).toLocaleString('en-IN')}`);
    res.json({ success: true, message: 'Scheduled!', id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all scheduled messages
app.get('/api/scheduler', (req, res) => {
  res.json({ messages: scheduledMessages, total: scheduledMessages.length });
});

// Cancel scheduled message
app.delete('/api/scheduler/:id', (req, res) => {
  const idx = scheduledMessages.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
  const msg = scheduledMessages[idx];
  if (msg.status !== 'pending') return res.status(400).json({ success: false, error: 'Can only cancel pending' });
  if (msg.filePath && fs.existsSync(msg.filePath)) fs.unlinkSync(msg.filePath);
  scheduledMessages.splice(idx, 1);
  saveScheduled(scheduledMessages);
  res.json({ success: true });
});

// Scheduler cron — check every 30 seconds
setInterval(() => {
  const now = new Date();
  for (const msg of scheduledMessages) {
    if (msg.status !== 'pending') continue;
    if (new Date(msg.scheduledAt) <= now) {
      console.log(`⏰ Executing scheduled: ${msg.id}`);
      executeScheduledMessage(msg);
    }
  }
}, 30000);

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, async () => {
  console.log(`\n🟢 Habuild Community Tracker running on http://localhost:${CONFIG.PORT}`);
  console.log(`📡 Webhook endpoint → http://YOUR_SERVER_IP:${CONFIG.PORT}/webhook`);
  console.log(`⚙️  Limits: Warn at ${CONFIG.WARN_LIMIT}, Alert at ${CONFIG.MAX_LIMIT}`);
  console.log(`📱 Configured phones: ${CONFIG.PHONE_IDS.length || 'auto-discovering...'}\n`);

  // Discover phones from Maytapi account
  await discoverPhones();

  // Initial full sync
  await syncAllGroups();

  // Auto re-sync every 30 minutes as a safety net
  setInterval(syncAllGroups, 30 * 60 * 1000);
});
