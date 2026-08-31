#!/usr/bin/env node
// Agent Mission Control — yerel toplayıcı.
// 1) http://localhost:5757 üzerinde yerel paneli sunar.
// 2) .env varsa durumu Supabase'e iter ve webden gelen komutları yerel kuyruğa uygular.
// Bağımlılık yok. Çalıştır: node local/collector.js   (test: --fixture <dizin>)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = Number(process.env.MC_PORT || 5757);
const HOME = os.homedir();
const REPO = path.join(__dirname, '..');

const fixIdx = process.argv.indexOf('--fixture');
const FIXTURE = fixIdx > -1 ? process.argv[fixIdx + 1] : null;
const TEAMS_ROOT = FIXTURE ? path.join(FIXTURE, 'teams') : path.join(HOME, '.claude', 'teams');
const TASKS_ROOT = FIXTURE ? path.join(FIXTURE, 'tasks') : path.join(HOME, '.claude', 'tasks');
const PROJECTS_ROOT = FIXTURE ? path.join(FIXTURE, 'projects') : path.join(HOME, '.claude', 'projects');
// Kuyruk ve takma adlar eski konumda kalır — ekip lideri bu dosyaları izliyor.
const DATA_DIR = process.env.MC_DATA || path.join(HOME, 'agent-mission-control');
const QUEUE_FILE = path.join(DATA_DIR, 'task-queue.md');
const META_FILE = path.join(DATA_DIR, 'agents.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json'); // { active, projects: { ad: {path, repo, url, status} } }
const WORK_DIR = process.env.MC_WORK || path.join(HOME, 'work'); // projelerin ana klasörü

// ---------- yardımcılar ----------
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const readJSON = (p) => safe(() => JSON.parse(fs.readFileSync(p, 'utf8')), null);
const listDir = (p) => safe(() => fs.readdirSync(p), []);
const mtime = (p) => safe(() => fs.statSync(p).mtimeMs, 0);

// .env (repo kökünde, gitignore'da): SUPABASE_URL, SUPABASE_ANON_KEY, PANEL_TOKEN
const ENV = {};
safe(() => {
  for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) ENV[m[1]] = m[2];
  }
}, null);
// Fixture (test) modunda bulut eşitleme kapalı — test verisi canlı paneli ezmesin.
const SYNC_ON = !FIXTURE && Boolean(ENV.SUPABASE_URL && ENV.SUPABASE_ANON_KEY && ENV.PANEL_TOKEN);

function firstTs(file) {
  return safe(() => {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const line = buf.toString('utf8', 0, n).split('\n')[0];
    const ts = JSON.parse(line).timestamp;
    return ts ? Date.parse(ts) : 0;
  }, 0);
}

function walkJsonl(dir, depth, out) {
  if (depth < 0) return;
  for (const f of listDir(dir)) {
    const p = path.join(dir, f);
    const st = safe(() => fs.statSync(p), null);
    if (!st) continue;
    if (st.isDirectory()) walkJsonl(p, depth - 1, out);
    else if (f.endsWith('.jsonl')) out.push({ p, f, mt: st.mtimeMs });
  }
}

function tailLines(file, maxBytes = 400 * 1024) {
  return safe(() => {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  }, []);
}

// Lider transcript'inden alt-agent adlarını çıkar
function extractAgentNames(file) {
  const descByToolUse = {}, nameById = {};
  for (const line of tailLines(file, 2 * 1024 * 1024)) {
    const obj = safe(() => JSON.parse(line), null);
    if (!obj || !obj.message) continue;
    const content = Array.isArray(obj.message.content) ? obj.message.content : [];
    for (const b of content) {
      if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && b.input) {
        descByToolUse[b.id] = b.input.description || b.input.subagent_type || '';
      } else if (b.type === 'tool_result' && b.tool_use_id && descByToolUse[b.tool_use_id]) {
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        const m = text.match(/agentId:\s*'?([a-f0-9]{10,})/i);
        if (m) nameById[m[1]] = descByToolUse[b.tool_use_id];
      }
    }
  }
  return nameById;
}

// Liderin henüz yanıtlanmamış AskUserQuestion çağrısını bul (panelden yanıtlamak için)
function scanPendingQuestion(file) {
  const asks = {}, answered = new Set();
  for (const line of tailLines(file)) {
    const obj = safe(() => JSON.parse(line), null);
    if (!obj || !obj.message) continue;
    const content = Array.isArray(obj.message.content) ? obj.message.content : [];
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.input) asks[b.id] = b.input;
      else if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  const ids = Object.keys(asks).filter(id => !answered.has(id));
  const id = ids[ids.length - 1];
  if (!id) return null;
  return {
    id,
    questions: (asks[id].questions || []).map(q => ({
      question: q.question, header: q.header || '',
      options: (q.options || []).map(o => ({ label: o.label, description: o.description || '' })),
    })),
  };
}

function compactInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => keys.map(k => input[k]).find(v => typeof v === 'string' && v.trim());
  let s = '';
  if (name === 'Bash') s = pick('description', 'command') || '';
  else if (name === 'SendMessage') s = `→ ${input.to || '?'} : ${typeof input.message === 'string' ? input.message : (input.summary || '')}`;
  else if (name === 'Read' || name === 'Write' || name === 'Edit') s = pick('file_path') || '';
  else if (name === 'TaskUpdate' || name === 'TaskCreate') s = pick('description', 'status', 'subject', 'content') || JSON.stringify(input).slice(0, 160);
  else s = pick('description', 'prompt', 'query', 'pattern', 'url') || JSON.stringify(input).slice(0, 160);
  return String(s).slice(0, 220);
}

function parseLine(line, agentName, events, messages) {
  const obj = safe(() => JSON.parse(line), null);
  if (!obj) return;
  const ts = obj.timestamp || null;
  const content = obj.message && obj.message.content;
  if (obj.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        events.push({ ts, kind: 'text', label: block.text.trim().slice(0, 260) });
      } else if (block.type === 'tool_use') {
        events.push({ ts, kind: 'tool', tool: block.name, label: compactInput(block.name, block.input) });
        if (block.name === 'SendMessage' && block.input) {
          messages.push({
            ts, from: agentName, to: String(block.input.to || '?'),
            text: (typeof block.input.message === 'string' ? block.input.message : (block.input.summary || '')).slice(0, 500),
          });
        }
      }
    }
  } else if (obj.type === 'user') {
    const texts = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) for (const b of content) {
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    for (const t of texts) {
      const m = t.match(/<cross-session-message from="([^"]+)"[^>]*>([\s\S]*?)(<\/cross-session-message>|$)/);
      if (m) events.push({ ts, kind: 'msg-in', label: `← ${m[1]} : ${m[2].trim().slice(0, 220)}` });
    }
  }
}

// GitHub repo listesi — gh CLI varsa 5 dakikada bir tazelenir (panelin "Repoyu Getir" listesi)
let ghRepos = [];
function refreshGhRepos() {
  execFile('gh', ['repo', 'list', '--limit', '100', '--json', 'name,nameWithOwner,visibility,updatedAt'],
    { timeout: 30_000 }, (err, stdout) => {
      if (err) return; // gh yok veya girişsiz — liste boş kalır
      const list = safe(() => JSON.parse(stdout), null);
      if (Array.isArray(list)) {
        ghRepos = list
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .map(r => ({ name: r.name, full: r.nameWithOwner, visibility: r.visibility }));
      }
    });
}
refreshGhRepos(); // açılışta bir kez; sonrası panelden istek üzerine (refresh-repos komutu)

function collectState() {
  const state = {
    generatedAt: new Date().toISOString(), teams: [], messages: [],
    queue: safe(() => fs.readFileSync(QUEUE_FILE, 'utf8'), ''),
    projectsInfo: readJSON(PROJECTS_FILE) || { active: null, projects: {} },
    ghRepos,
  };
  const now = Date.now();

  for (const teamName of listDir(TEAMS_ROOT)) {
    const teamDir = path.join(TEAMS_ROOT, teamName);
    const config = readJSON(path.join(teamDir, 'config.json')) || {};
    const members = Array.isArray(config.members) ? config.members : [];
    const teamStart = Number(config.createdAt) || mtime(path.join(teamDir, 'config.json'));

    const inboxes = {};
    for (const f of listDir(path.join(teamDir, 'inboxes'))) {
      const data = readJSON(path.join(teamDir, 'inboxes', f));
      if (data) inboxes[f.replace(/\.json$/, '')] = data;
    }

    const tasks = [];
    const taskDir = path.join(TASKS_ROOT, teamName);
    for (const f of listDir(taskDir).sort()) {
      const p = path.join(taskDir, f);
      const j = readJSON(p);
      if (j) tasks.push(j);
      else tasks.push({ raw: safe(() => fs.readFileSync(p, 'utf8').slice(0, 400), f) });
    }

    // Son 12 saatte değişen transcript dosyaları (subagents/ alt dizinleri dahil)
    const candidates = [];
    walkJsonl(PROJECTS_ROOT, 4, candidates);
    const fresh = candidates.filter(c => now - c.mt < 12 * 3600 * 1000 && c.mt >= teamStart - 60_000);

    const used = new Set();
    const agents = members.map(m => ({
      name: m.name || m.agentId || '?', type: m.agentType || '',
      ids: [m.sessionId, m.id, m.agentId, String(m.agentId || '').split('@')[0]].filter(Boolean),
      file: null,
    }));
    // 1) Lider: leadSessionId dosya adıyla birebir eşleşir
    let leadFile = null;
    if (config.leadSessionId) {
      const lead = agents.find(a => a.type === 'team-lead');
      const hit = fresh.find(c => c.f === config.leadSessionId + '.jsonl');
      if (lead && hit) { lead.file = hit.p; used.add(hit.p); leadFile = hit.p; }
    }
    const autoNames = leadFile ? extractAgentNames(leadFile) : {};
    // 2) Üye kimliklerinden biri dosya adında geçiyor mu
    for (const a of agents) {
      if (a.file) continue;
      const hit = fresh.find(c => !used.has(c.p) && a.ids.some(id => c.f.includes(String(id))));
      if (hit) { a.file = hit.p; used.add(hit.p); }
    }
    // 3) İçerikte üye adı geçiyor mu (ekip başladıktan SONRA açılmış oturumlarda)
    const bornAfter = fresh.filter(c => !used.has(c.p) && firstTs(c.p) >= teamStart - 60_000);
    for (const a of agents) {
      if (a.file) continue;
      const hit = bornAfter.find(c => !used.has(c.p) &&
        safe(() => tailLines(c.p, 64 * 1024).slice(0, 40).join('\n').includes(`"${a.name}"`), false));
      if (hit) { a.file = hit.p; used.add(hit.p); }
    }
    // 4) Eşleşmeyen ama ekip başladıktan sonra AÇILMIŞ oturumlar da birer pano olsun
    for (const c of bornAfter.filter(c => !used.has(c.p)).slice(0, 8)) {
      const stem = path.basename(c.f, '.jsonl');
      const id = stem.startsWith('agent-') ? stem.slice(6) : stem;
      const auto = autoNames[id];
      agents.push({
        name: auto || stem.slice(0, 12) + '…',
        type: auto ? 'alt-agent' : 'eşleşmemiş oturum',
        ids: [], file: c.p, key: stem,
      });
    }
    // Takma ad + rol tanımlarını uygula
    const meta = readJSON(META_FILE) || {};
    for (const a of agents) {
      if (!a.key) a.key = 'member:' + a.name;
      const m = meta[a.key];
      if (m) { a.alias = m.alias || ''; a.role = m.role || ''; }
    }

    for (const a of agents) {
      const events = [];
      if (a.file) {
        for (const line of tailLines(a.file)) parseLine(line, a.alias || a.name, events, state.messages);
        a.lastActivity = mtime(a.file);
        a.status = now - a.lastActivity < 20_000 ? 'calisiyor' : 'bekliyor';
        if (a.type === 'team-lead') {
          a.pendingQuestion = scanPendingQuestion(a.file);
          lastLeadFile = a.file; // lead-answer doğrulaması için
        }
      } else {
        a.status = 'transcript-yok';
      }
      a.events = events.slice(-40);
      delete a.file; delete a.ids;
    }

    state.teams.push({ name: teamName, agents, tasks, inboxes });
  }

  state.messages.sort((x, y) => String(x.ts || '').localeCompare(String(y.ts || '')));
  state.messages = state.messages.slice(-60);
  return state;
}

// ---------- komut uygulayıcılar (yerel API ve buluttan gelen komutlar ortak) ----------
function doAssign(agent, text) {
  agent = String(agent || 'lider').replace(/[\n\r]/g, ' ').slice(0, 60);
  text = String(text || '').replace(/\r/g, '').slice(0, 2000).trim();
  if (!text) return false;
  fs.appendFileSync(QUEUE_FILE, `- [ ] (${new Date().toISOString()}) **${agent}** için: ${text}\n`);
  return true;
}

function doMeta(key, alias, role) {
  if (!key) return false;
  const meta = readJSON(META_FILE) || {};
  meta[String(key).slice(0, 120)] = {
    alias: String(alias || '').slice(0, 60),
    role: String(role || '').slice(0, 500),
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  return true;
}

function doControl(action, name, role) {
  name = String(name || '').replace(/[\n\r]/g, ' ').slice(0, 60).trim();
  role = String(role || '').replace(/\r/g, '').slice(0, 1500).trim();
  let line = null;
  if (action === 'add' && name) {
    line = `- [ ] (${new Date().toISOString()}) **lider** için: YENİ EKİP ÜYESİ OLUŞTUR — adı: "${name}". Genel görev tanımı: ${role || '(belirtilmedi)'} — Bu üyeyi ekibe kat, rol tanımını kendisine ilet ve hazır olduğunda kuyruğu kontrol etmesini söyle.\n`;
  } else if (action === 'remove' && name) {
    line = `- [ ] (${new Date().toISOString()}) **lider** için: EKİP ÜYESİNİ ÇIKAR — adı: "${name}". Devam eden işini toparlamasına izin ver, sonra kapat ve durumu raporla.\n`;
  }
  if (line) fs.appendFileSync(QUEUE_FILE, line);
  return Boolean(line);
}

function doProject(action, name, repoFull) {
  name = String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!name) return false;
  repoFull = String(repoFull || '').replace(/[^A-Za-z0-9-_./]/g, '').slice(0, 120);
  const reg = readJSON(PROJECTS_FILE) || { active: null, projects: {} };
  const now = new Date().toISOString();
  if (action === 'switch') {
    if (!reg.projects[name]) return false;
    reg.active = name;
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(reg, null, 2));
    fs.appendFileSync(QUEUE_FILE,
      `- [ ] (${now}) **lider** için: AKTİF PROJE DEĞİŞTİ — artık "${name}" (${WORK_DIR}/${name}). Bundan sonraki görevler bu klasörde çalışır; ekibe duyur ve bu satırı [x] yap.\n`);
    return true;
  }
  if (action === 'import') {
    if (!repoFull || reg.projects[name]) return false;
    reg.projects[name] = { path: `${WORK_DIR}/${name}`, repo: `https://github.com/${repoFull}`, url: '', status: 'kuruluyor', createdAt: now };
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(reg, null, 2));
    fs.appendFileSync(QUEUE_FILE,
      `- [ ] (${now}) **lider** için: GITHUB REPOSUNU PROJE OLARAK GETİR — "${repoFull}". Adımlar: 1) \`gh repo clone ${repoFull} ${WORK_DIR}/${name}\` ile klonla (klasör zaten varsa güncelle: git pull). 2) Vercel bağlantısını dene: klasör içinde \`vercel link --yes --project ${name}\`; bağlanırsa production URL'ini bul (\`vercel inspect\` veya \`vercel ls\`) — Vercel'de böyle bir proje yoksa url'i boş bırak, deploy'u ayrı bir görevle yaparız. 3) ${PROJECTS_FILE} dosyasındaki projects["${name}"] kaydını güncelle: url alanını (varsa) doldur, status "hazır", active "${name}". 4) Projeyi kısaca keşfet (ne projesi, hangi teknoloji) ve bu satırı [x] yapıp sonuna tek cümlelik özet + varsa URL yaz.\n`);
    return true;
  }
  if (action === 'create') {
    if (reg.projects[name]) return false;
    reg.projects[name] = { path: `${WORK_DIR}/${name}`, repo: '', url: '', status: 'kuruluyor', createdAt: now };
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(reg, null, 2));
    fs.appendFileSync(QUEUE_FILE,
      `- [ ] (${now}) **lider** için: YENİ PROJE OLUŞTUR — adı "${name}". Adımlar: 1) ${WORK_DIR}/${name} klasörünü aç, git init + anlamlı bir ilk commit. 2) \`gh repo create ${name} --private --source=. --push\` ile GitHub reposunu aç. 3) Vercel'e bağla ve production deploy et: klasör içinde \`vercel link --yes --project ${name}\` sonra \`vercel --prod --yes\`; çıkan production URL'ini al. 4) ${PROJECTS_FILE} dosyasındaki projects["${name}"] kaydını güncelle: repo ve url alanlarını doldur, status "hazır" yap, active alanını "${name}" yap. 5) Bu satırı [x] yapıp sonuna URL'i yaz. Hata olursa status "hata" yap ve satıra nedeni not et.\n`);
    return true;
  }
  return false;
}

// ---- liderle doğrudan etkileşim (liderin tmux oturumuna tuş göndererek) ----
const LEAD_TMUX = process.env.MC_LEAD_TMUX || 'lead';
let lastLeadFile = null;

function tmuxKeys(args, cb) {
  execFile('tmux', ['send-keys', '-t', LEAD_TMUX, ...args], { timeout: 10_000 }, (err) => cb && cb(!err));
}

function doLeadMsg(text) {
  text = String(text || '').replace(/[\r\n]+/g, ' ').slice(0, 2000).trim();
  if (!text) return false;
  tmuxKeys(['-l', text], (ok) => { if (ok) setTimeout(() => tmuxKeys(['Enter']), 300); });
  return true;
}

function doLeadAnswer(toolUseId, optionIndex) {
  optionIndex = Math.max(0, Math.min(10, Number(optionIndex) || 0));
  // Soru hâlâ açık mı? Kapandıysa tuş göndermek liderin yazı kutusuna karışır — gönderme.
  const pending = lastLeadFile ? scanPendingQuestion(lastLeadFile) : null;
  if (!pending || pending.id !== toolUseId) return false;
  const keys = Array(optionIndex).fill('Down').concat(['Enter']);
  tmuxKeys(keys);
  return true;
}

const COMMAND_HANDLERS = {
  'assign': (p) => doAssign(p.agent, p.text),
  'agent-meta': (p) => doMeta(p.key, p.alias, p.role),
  'team-control': (p) => doControl(p.action, p.name, p.role),
  'project': (p) => doProject(p.action, p.name, p.repo),
  'refresh-repos': () => refreshGhRepos(),
  'lead-msg': (p) => doLeadMsg(p.text),
  'lead-answer': (p) => doLeadAnswer(p.id, p.index),
};

function applyCommand(payload) {
  if (!payload || typeof payload !== 'object') return;
  const handler = COMMAND_HANDLERS[payload.type];
  if (handler) handler(payload);
}

// ---------- Supabase eşitleme ----------
async function rpc(fn, args) {
  const res = await fetch(`${ENV.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ENV.SUPABASE_ANON_KEY,
               Authorization: `Bearer ${ENV.SUPABASE_ANON_KEY}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let lastSyncError = '';
async function syncLoop() {
  try {
    const state = collectState();
    await rpc('state_put', { p_token: ENV.PANEL_TOKEN, p_state: state });
    const commands = await rpc('commands_pop', { p_token: ENV.PANEL_TOKEN });
    for (const c of commands || []) applyCommand(c);
    if (lastSyncError) { console.log('eşitleme düzeldi'); lastSyncError = ''; }
  } catch (e) {
    if (String(e) !== lastSyncError) { console.error('eşitleme hatası:', String(e).slice(0, 200)); lastSyncError = String(e); }
  }
}

// ---------- http ----------
const server = http.createServer((req, res) => {
  const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = (cb) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 20_000) req.destroy(); });
    req.on('end', () => cb(safe(() => JSON.parse(body), {})));
  };
  if (req.url === '/api/state') return json(collectState());
  if (req.url === '/api/assign' && req.method === 'POST') return readBody(j => json({ ok: doAssign(j.agent, j.text) }));
  if (req.url === '/api/agent-meta' && req.method === 'POST') return readBody(j => json({ ok: doMeta(j.key, j.alias, j.role) }));
  if (req.url === '/api/team-control' && req.method === 'POST') return readBody(j => json({ ok: doControl(j.action, j.name, j.role) }));
  if (req.url === '/api/project' && req.method === 'POST') return readBody(j => json({ ok: doProject(j.action, j.name, j.repo) }));
  if (req.url === '/api/refresh-repos' && req.method === 'POST') { refreshGhRepos(); return json({ ok: true }); }
  if (req.url === '/api/lead-msg' && req.method === 'POST') return readBody(j => json({ ok: doLeadMsg(j.text) }));
  if (req.url === '/api/lead-answer' && req.method === 'POST') return readBody(j => json({ ok: doLeadAnswer(j.id, j.index) }));
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(REPO, 'index.html')));
  }
  if (req.url === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(safe(() => fs.readFileSync(path.join(REPO, 'config.js')), 'window.PANEL_CONFIG={};'));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mission Control (yerel): http://localhost:${PORT}` + (FIXTURE ? ` (fixture: ${FIXTURE})` : ''));
  console.log(`izlenen: teams=${TEAMS_ROOT} tasks=${TASKS_ROOT} projects=${PROJECTS_ROOT}`);
  console.log(SYNC_ON ? 'bulut eşitleme: AÇIK (3sn)' : 'bulut eşitleme: kapalı (.env eksik)');
  if (SYNC_ON) { syncLoop(); setInterval(syncLoop, 3000); }
});
