// scripts/l2tp.mjs  —  استفاده:  node scripts/l2tp.mjs
// Node 20+ ، بدون وابستگی خارجی
// کار: دریافت لیست vpngate.net و ipspeed.info ← تست زنده بودن IKE روی UDP 500 ← نوشتن UcL2tp.txt
// فرمت هر خط:  L2TP:server:port:username:password:psk:name:country
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ───────────────────────── تنظیمات ─────────────────────────
const OUT_FILE = process.env.OUT_FILE || 'UcL2tp.txt';
const DATA_DIR = 'data';
const HEARTBEAT_FILE = path.join(DATA_DIR, 'l2tp-heartbeat.txt'); // هر اجرا عوض می‌شود تا ریپو فعال بماند
const CONCURRENCY = Number(process.env.CONCURRENCY || 150);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 4000);
const MAX_SERVERS = Number(process.env.MAX_SERVERS || 100); // هر سرور حداکثر ۲ خط (هاست‌نیم + آی‌پی)
const MIN_ALIVE_TO_SAVE = 3;                                 // کمتر از این → فایل قبلی حفظ می‌شود
const NAME_PREFIX = '@UCIRANIR';
const CSV_URL = 'http://www.vpngate.net/api/iphone/';
const VPNGATE_HTML = 'https://www.vpngate.net/en/';
const IPSPEED_URL = 'https://ipspeed.info/free-l2tpipsec.php';
const DOMAIN = '.opengw.net';
const UA = 'Mozilla/5.0 (compatible; l2tp-scanner/1.0)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// جدول پشتیبان نام کشور ← کد
const COUNTRY_FALLBACK = {
  'Korea Republic of': 'KR', 'Japan': 'JP', 'United States': 'US', 'Thailand': 'TH', 'Viet Nam': 'VN',
  'Russian Federation': 'RU', 'Hong Kong': 'HK', 'Taiwan': 'TW', 'Singapore': 'SG', 'Canada': 'CA',
  'United Kingdom': 'GB', 'Germany': 'DE', 'France': 'FR', 'Netherlands': 'NL', 'India': 'IN',
  'Indonesia': 'ID', 'Philippines': 'PH', 'Australia': 'AU', 'Brazil': 'BR', 'Ukraine': 'UA',
  'Turkey': 'TR', 'China': 'CN', 'Italy': 'IT', 'Spain': 'ES',
};

// ───────────────────────── ابزارهای کمکی ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, ua = UA, tries = 3) {
  let last = 'نامشخص';
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,text/csv,*/*' },
        signal: AbortSignal.timeout(45000),
      });
      if (r.ok) return await r.text();
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.message; }
    console.log(`  تلاش ${i}/${tries} برای ${url} ناموفق بود: ${last}`);
    await sleep(3000 * i);
  }
  throw new Error(`دریافت ${url} ناموفق: ${last}`);
}

const htmlToText = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ───────────────────────── پارس CSV وی‌پی‌ان‌گیت ─────────────────────────
// ستون‌ها: HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,...
export function parseCsv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || line.startsWith('#')) continue;
    const cols = line.split(',');
    if (cols.length < 8 || !net.isIPv4(cols[1])) continue;
    out.push({ hostName: cols[0], ip: cols[1], countryLong: cols[5] || '', cc: (cols[6] || '').toUpperCase() });
  }
  return out;
}

// ───────────────────────── پارس HTML وی‌پی‌ان‌گیت ─────────────────────────
// هر سطر جدول که هاست‌نیم opengw.net و IP داشته باشد
export function parseVpngateHtml(html, countryNames = []) {
  const names = [...countryNames].sort((a, b) => b.length - a.length);
  const out = [];
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const text = htmlToText(chunk);
    const host = /\b([A-Za-z0-9-]+\.opengw\.net)\b/i.exec(text)?.[1];
    const ip = /\b((?:\d{1,3}\.){3}\d{1,3})\b/.exec(text)?.[1];
    if (!host || !ip || !net.isIPv4(ip)) continue;
    out.push({ host: host.toLowerCase(), ip, countryLong: names.find((n) => text.startsWith(n)) || '' });
  }
  return out;
}

// ───────────────────────── پارس جدول ipspeed ─────────────────────────
// سطرها مثل:  1 Japan 219.100.37.176 19 days 10 ms
export function parseIpspeed(html) {
  const out = [];
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const text = htmlToText(chunk);
    const m = /^\d+\s+(.+?)\s+((?:\d{1,3}\.){3}\d{1,3})\b/.exec(text);
    if (m && net.isIPv4(m[2])) out.push({ ip: m[2], countryLong: m[1].trim() });
  }
  return out;
}

// ───────────────────────── ساخت لیست کاندیدها ─────────────────────────
export function buildCandidates(csvRows, vgRows, ipsRows) {
  const longToShort = new Map(Object.entries(COUNTRY_FALLBACK));
  const ipToCc = new Map();
  for (const r of csvRows) {
    if (r.countryLong && r.cc) longToShort.set(r.countryLong, r.cc);
    if (r.cc) ipToCc.set(r.ip, r.cc);
  }
  const map = new Map(); // کلید: ip
  const add = (ip, host, cc) => {
    const cur = map.get(ip);
    if (!cur) map.set(ip, { ip, host: host || '', cc: (cc || 'xx').toLowerCase() });
    else {
      if (host && !cur.host) cur.host = host;
      if (cc && cur.cc === 'xx') cur.cc = cc.toLowerCase();
    }
  };
  for (const r of csvRows) {
    const h = r.hostName.toLowerCase();
    add(r.ip, h.includes('.') ? h : h + DOMAIN, r.cc);
  }
  for (const r of vgRows) add(r.ip, r.host, ipToCc.get(r.ip) || longToShort.get(r.countryLong));
  for (const r of ipsRows) add(r.ip, '', ipToCc.get(r.ip) || longToShort.get(r.countryLong));
  return [...map.values()];
}

// ───────────────────────── تست IKE روی UDP 500 ─────────────────────────
// L2TP/IPsec با IKE شروع می‌شود. یک بسته Main Mode می‌فرستیم؛ هر پاسخ IKE با کوکی ما یعنی سرور زنده است
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const tv = (type, val) => Buffer.concat([u16(0x8000 | type), u16(val)]);

function transform(num, enc, keyLen, hash, last) {
  const attrs = [tv(1, enc)];
  if (keyLen) attrs.push(tv(14, keyLen));
  attrs.push(tv(2, hash), tv(3, 1), tv(4, 2), tv(11, 1), tv(12, 28800)); // PSK ، گروه ۲ ، عمر ۲۸۸۰۰ ثانیه
  const body = Buffer.concat(attrs);
  const head = Buffer.alloc(8);
  head[0] = last ? 0 : 3;
  head.writeUInt16BE(8 + body.length, 2);
  head[4] = num;
  head[5] = 1; // KEY_IKE
  return Buffer.concat([head, body]);
}

export function buildIke(cookie) {
  // (رمزگذاری، طول کلید، هش): 3DES-SHA1 ، 3DES-MD5 ، AES128-SHA1 ، AES256-SHA1
  const defs = [[5, 0, 2], [5, 0, 1], [7, 128, 2], [7, 256, 2]];
  const trs = Buffer.concat(defs.map((d, i) => transform(i + 1, d[0], d[1], d[2], i === defs.length - 1)));
  const prop = Buffer.alloc(8);
  prop.writeUInt16BE(8 + trs.length, 2);
  prop[4] = 1; // شماره پروپوزال
  prop[5] = 1; // پروتکل ISAKMP
  prop[7] = defs.length;
  const proposal = Buffer.concat([prop, trs]);
  const sa = Buffer.alloc(12);
  sa.writeUInt16BE(12 + proposal.length, 2);
  sa.writeUInt32BE(1, 4); // DOI = IPSEC
  sa.writeUInt32BE(1, 8); // Situation = IDENTITY_ONLY
  const saFull = Buffer.concat([sa, proposal]);
  const hdr = Buffer.alloc(28);
  cookie.copy(hdr, 0);
  hdr[16] = 1;    // payload بعدی = SA
  hdr[17] = 0x10; // نسخه IKEv1
  hdr[18] = 2;    // Main Mode
  hdr.writeUInt32BE(28 + saFull.length, 24);
  return Buffer.concat([hdr, saFull]);
}

export function probe(ip, port = 500, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const cookie = crypto.randomBytes(8);
    const pkt = buildIke(cookie);
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let done = false;
    let iv, timer;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(iv);
      clearTimeout(timer);
      try { sock.close(); } catch { /* بی‌اهمیت */ }
      resolve(ok ? Date.now() - t0 : -1);
    };
    sock.on('error', () => finish(false));
    sock.on('message', (m) => { if (m.length >= 28 && m.subarray(0, 8).equals(cookie)) finish(true); });
    const send = () => { try { sock.send(pkt, port, ip, (e) => { if (e) finish(false); }); } catch { finish(false); } };
    send();
    iv = setInterval(send, 1500); // UDP ممکن است گم شود، دوباره می‌فرستیم
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// ───────────────────────── خروجی ─────────────────────────
// هر سرور: خط هاست‌نیم و درست زیرش خط آی‌پی (اگر هاست‌نیم نداشت فقط آی‌پی). نام‌ها پشت‌سرهم شماره می‌خورند
export function formatLines(sorted, maxServers = MAX_SERVERS) {
  const lines = [];
  let n = 0, servers = 0;
  const line = (server, cc) => `L2TP:${server}::vpn:vpn:vpn:${NAME_PREFIX}${++n}:${cc}`;
  for (const a of sorted) {
    if (a.host) lines.push(line(a.host, a.cc));
    lines.push(line(a.ip, a.cc));
    if (++servers >= maxServers) break;
  }
  return { lines, servers };
}

function writeHeartbeat(note) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, `${new Date().toISOString()}\n${note}\n`);
}

async function cmdScan() {
  console.log('دریافت لیست‌ها ...');
  let csvRows = [], vgRows = [], ipsRows = [];
  try { csvRows = parseCsv(await fetchText(CSV_URL)); console.log(`vpngate CSV: ${csvRows.length} سرور`); }
  catch (e) { console.log('خطا در CSV: ' + e.message); }

  const names = [...new Set([...csvRows.map((r) => r.countryLong).filter(Boolean), ...Object.keys(COUNTRY_FALLBACK)])];
  try { vgRows = parseVpngateHtml(await fetchText(VPNGATE_HTML), names); console.log(`vpngate HTML: ${vgRows.length} سرور`); }
  catch (e) { console.log('خطا در HTML وی‌پی‌ان‌گیت: ' + e.message); }

  try { ipsRows = parseIpspeed(await fetchText(IPSPEED_URL, BROWSER_UA, 2)); console.log(`ipspeed: ${ipsRows.length} سرور`); }
  catch (e) { console.log('ipspeed در دسترس نبود (رد شد): ' + e.message); }

  const targets = buildCandidates(csvRows, vgRows, ipsRows);
  if (!targets.length) {
    console.log('هیچ سروری دریافت نشد — فایل قبلی حفظ شد');
    writeHeartbeat('دریافت لیست ناموفق بود');
    return;
  }

  console.log(`شروع اسکن ${targets.length} آی‌پی با ${CONCURRENCY} اتصال همزمان`);
  const alive = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      const ms = await probe(t.ip);
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

  alive.sort((a, b) => a.ms - b.ms);
  const { lines, servers } = formatLines(alive);
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  writeHeartbeat(`زنده: ${alive.length}/${targets.length} — ذخیره: ${servers} سرور (${lines.length} خط)`);
  console.log(`${servers} سرور (${lines.length} خط) در ${OUT_FILE} ذخیره شد`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cmdScan();
}
