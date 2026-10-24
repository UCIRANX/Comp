// scripts/ovpn.mjs  —  استفاده:  node scripts/ovpn.mjs
// Node 20+ ، بدون وابستگی خارجی
// کار: دریافت لیست vpngate.net  ←  اسکن واقعی OpenVPN (TCP و UDP)  ←  نوشتن UcOvpn.txt
// فرمت هر خط:  proto:cc:base64(کانفیگ کامل OpenVPN)
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ───────────────────────── تنظیمات ─────────────────────────
const OUT_FILE = process.env.OUT_FILE || 'UcOvpn.txt';
const DATA_DIR = 'data';
const HEARTBEAT_FILE = path.join(DATA_DIR, 'ovpn-heartbeat.txt'); // هر اجرا عوض می‌شود تا ریپو فعال بماند
const CONCURRENCY = Number(process.env.CONCURRENCY || 150);       // تعداد تست همزمان
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 7000);        // مهلت کل هر سرور
const UDP_TRIES = 2;                                              // UDP پاسخ تضمین‌شده ندارد، پس دو بار تست می‌شود
const MAX_SERVERS = 50;                                           // حداکثر ۵۰ کانفیگ در هر اجرا، هر کانفیگ یک خط
const MIN_ALIVE_TO_SAVE = 3;                                      // کمتر از این → فایل قبلی حفظ می‌شود
const CSV_URL = 'http://www.vpngate.net/api/iphone/';
const DOMAIN = '.opengw.net';
const UA = 'Mozilla/5.0 (compatible; ovpn-scanner/1.0)';

// کدهای opcode در OpenVPN
const OP_HARD_RESET_CLIENT_V2 = 7;
const OP_HARD_RESET_SERVER_V2 = 8;

// ───────────────────────── ابزارهای کمکی ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  let last = 'نامشخص';
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) { last = `HTTP ${r.status}`; }
      else { return await r.text(); }
    } catch (e) { last = e.message; }
    console.log(`  تلاش ${i}/${tries} برای ${url} ناموفق بود: ${last}`);
    await sleep(3000 * i);
  }
  throw new Error(`دریافت ${url} ناموفق: ${last}`);
}

// ───────────────────────── پارس CSV ─────────────────────────
// ستون‌ها: HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,... ، آخرین ستون = کانفیگ OpenVPN (base64)
export function parseCsv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || line.startsWith('#')) continue;
    const cols = line.split(',');
    if (cols.length < 8) continue;
    const ip = cols[1];
    if (!net.isIPv4(ip)) continue;
    let cfg = '';
    try { cfg = Buffer.from(cols[cols.length - 1], 'base64').toString('utf8'); } catch { continue; }
    const protoRaw = /^\s*proto\s+(\w+)/im.exec(cfg)?.[1]?.toLowerCase() || '';
    const proto = protoRaw.startsWith('tcp') ? 'tcp' : protoRaw === 'udp' ? 'udp' : '';
    const remote = /^\s*remote\s+\S+\s+(\d{1,5})/im.exec(cfg);
    if (!proto || !remote) continue; // بدون پروتکل یا پورت، تست معنا ندارد
    out.push({
      hostName: cols[0],
      ip,
      countryLong: cols[5] || '',
      cc: (cols[6] || '').toUpperCase(),
      proto,
      port: Number(remote[1]),
      // سرورهایی که tls-auth یا tls-crypt دارند، پاسخ را فقط با کلید درست می‌دهند (در بخش تست توضیح داده شده)
      cfgB64: cols[cols.length - 1],
      tls: /(^\s*tls-(auth|crypt)\b)|<tls-(auth|crypt)>/im.test(cfg),
    });
  }
  return out;
}

// ───────────────────────── ساخت لیست کاندیدها ─────────────────────────
// هر ترکیب ip + proto + port یک هدف است (یک سرور ممکن است هم TCP و هم UDP داشته باشد)
export function buildTargets(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.ip}:${r.proto}:${r.port}`;
    if (map.has(key)) continue;
    const h = r.hostName.toLowerCase();
    map.set(key, {
      ip: r.ip,
      port: r.port,
      proto: r.proto,
      host: h.includes('.') ? h : h + DOMAIN,
      cc: r.cc || 'XX',
      tls: r.tls,
      cfgB64: r.cfgB64,
    });
  }
  return [...map.values()];
}

// ───────────────────────── تست واقعی OpenVPN ─────────────────────────
// بسته‌ی HARD_RESET_CLIENT_V2 با session id تصادفی می‌فرستیم.
// اگر سرور OpenVPN زنده باشد، با HARD_RESET_SERVER_V2 جواب می‌دهد (opcode = 8).
// ساختار: opcode/key_id (1 بایت) | session id (8) | تعداد ack (1، صفر) | message packet id (4، صفر)
function resetPacket() {
  const body = Buffer.alloc(1 + 8 + 1 + 4);
  body[0] = OP_HARD_RESET_CLIENT_V2 << 3;
  body.set(crypto.randomBytes(8), 1);
  return body;
}

// TCP: قبل از بسته، دو بایت طول (big-endian) می‌آید
function tcpFramedReset() {
  const body = resetPacket();
  const framed = Buffer.alloc(2 + body.length);
  framed.writeUInt16BE(body.length, 0);
  body.copy(framed, 2);
  return framed;
}

export function probeTcp(c, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host: c.ip, port: c.port });
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* بی‌اهمیت */ }
      resolve(ok ? Date.now() - t0 : -1);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
    sock.on('connect', () => sock.write(tcpFramedReset()));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 3) return;
      // بایت سوم = opcode (بعد از دو بایت طول)
      finish((buf[2] >> 3) === OP_HARD_RESET_SERVER_V2);
    });
  });
}

function udpOnce(c, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const sock = dgram.createSocket('udp4');
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* بی‌اهمیت */ }
      resolve(ok ? Date.now() - t0 : -1);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => finish(false));
    sock.on('message', (msg) => finish(msg.length > 0 && (msg[0] >> 3) === OP_HARD_RESET_SERVER_V2));
    sock.send(resetPacket(), c.port, c.ip, (err) => { if (err) finish(false); });
  });
}

// UDP: چند بار تست می‌شود تا یک بسته‌ی گم‌شده باعث حذف سرور سالم نشود
export async function probeUdp(c, timeoutMs = TIMEOUT_MS) {
  const perTry = Math.floor(timeoutMs / UDP_TRIES);
  for (let i = 0; i < UDP_TRIES; i++) {
    const ms = await udpOnce(c, perTry);
    if (ms >= 0) return ms;
  }
  return -1;
}

export function probe(c) {
  return c.proto === 'tcp' ? probeTcp(c) : probeUdp(c);
}

// ───────────────────────── خروجی ─────────────────────────
function writeHeartbeat(note) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, `${new Date().toISOString()}\n${note}\n`);
}

async function cmdScan() {
  console.log('دریافت لیست از vpngate.net ...');
  let rows = [];
  try { rows = parseCsv(await fetchText(CSV_URL)); console.log(`CSV: ${rows.length} سرور دارای کانفیگ OpenVPN`); }
  catch (e) { console.log('خطا در CSV: ' + e.message); }

  const targets = buildTargets(rows);
  if (!targets.length) {
    console.log('هیچ سروری دریافت نشد — فایل قبلی حفظ شد');
    writeHeartbeat('دریافت لیست ناموفق بود');
    return;
  }

  const tcpCount = targets.filter((t) => t.proto === 'tcp').length;
  const udpCount = targets.length - tcpCount;
  const tlsCount = targets.filter((t) => t.tls).length;
  console.log(`اهداف: ${targets.length} (TCP: ${tcpCount}، UDP: ${udpCount})`);
  console.log(`از این تعداد ${tlsCount} سرور tls-auth/tls-crypt دارند و ممکن است در تست کم‌شمار باشند`);
  console.log(`شروع اسکن با ${CONCURRENCY} تست همزمان`);

  const alive = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      const ms = await probe(t);
      if (ms >= 0) alive.push({ ...t, ms });
      if (++done % 500 === 0) console.log(`  ${done}/${targets.length} — زنده: ${alive.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`زنده: ${alive.length}/${targets.length}`);

  if (alive.length < MIN_ALIVE_TO_SAVE) {
    console.log('تعداد پاسخ‌دهنده خیلی کم است — فایل قبلی حفظ شد');
    writeHeartbeat(`زنده: ${alive.length}/${targets.length} (ذخیره نشد)`);
    return;
  }

  // یک خط برای هر ip+proto (سریع‌ترین). هر خط: proto:cc:base64
  alive.sort((a, b) => a.ms - b.ms);
  const seen = new Set();
  const lines = [];
  let count = 0;
  for (const a of alive) {
    const k = `${a.ip}:${a.proto}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`${a.proto}:${a.cc}:${a.cfgB64}`);
    if (++count >= MAX_SERVERS) break;
  }
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  writeHeartbeat(`زنده: ${alive.length}/${targets.length} — ذخیره: ${count} سرور (${lines.length} خط)`);
  console.log(`${count} سرور (${lines.length} خط) در ${OUT_FILE} ذخیره شد`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cmdScan();
}
