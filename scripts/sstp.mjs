// scripts/sstp.mjs  —  استفاده:  node scripts/sstp.mjs
// Node 20+ ، بدون وابستگی خارجی
// کار: دریافت لیست vpngate.net  ←  اسکن واقعی SSTP  ←  نوشتن sstp.txt
// فرمت هر خط:  hostname:port:vpn:vpn:country
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

// ───────────────────────── تنظیمات ─────────────────────────
const OUT_FILE = process.env.OUT_FILE || 'UCsstp.txt';        // خروجی اصلی (ریشه ریپو)
const DATA_DIR = 'data';
const HEARTBEAT_FILE = path.join(DATA_DIR, 'heartbeat.txt'); // هر اجرا عوض می‌شود تا ریپو فعال بماند
const CONCURRENCY = Number(process.env.CONCURRENCY || 150);  // تعداد اتصال همزمان
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 7000);   // مهلت هر سرور
const MAX_SAVED = Number(process.env.MAX_SAVED || 300);      // حداکثر خط در خروجی
const MIN_ALIVE_TO_SAVE = 3;                                 // کمتر از این → فایل قبلی حفظ می‌شود
const HOST_MODE = process.env.HOST_MODE || 'hostname';       // hostname | ip
const CSV_URL = 'http://www.vpngate.net/api/iphone/';
const HTML_URLS = ['https://www.vpngate.net/en/'];
const FALLBACK_PORTS = [443, 995, 992];                      // وقتی پورت TCP سرور معلوم نیست
const DOMAIN = '.opengw.net';
const UA = 'Mozilla/5.0 (compatible; sstp-scanner/1.0)';

// جدول پشتیبان نام کشور ← کد (برای سرورهایی که فقط در HTML هستند و در CSV نیستند)
const COUNTRY_FALLBACK = {
  'Korea Republic of': 'KR', 'Japan': 'JP', 'United States': 'US', 'Thailand': 'TH', 'Viet Nam': 'VN',
  'Russian Federation': 'RU', 'Hong Kong': 'HK', 'Taiwan': 'TW', 'Singapore': 'SG', 'Canada': 'CA',
  'United Kingdom': 'GB', 'Germany': 'DE', 'France': 'FR', 'Netherlands': 'NL', 'India': 'IN',
  'Indonesia': 'ID', 'Philippines': 'PH', 'Australia': 'AU', 'Brazil': 'BR', 'Ukraine': 'UA',
  'Turkey': 'TR', 'Iran (ISLAMIC Republic Of)': 'IR', 'China': 'CN', 'Italy': 'IT', 'Spain': 'ES',
};

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
    let tcpPort = 0;
    try {
      const cfg = Buffer.from(cols[cols.length - 1], 'base64').toString('utf8');
      const proto = /^\s*proto\s+(\w+)/im.exec(cfg)?.[1]?.toLowerCase() || '';
      const remote = /^\s*remote\s+\S+\s+(\d+)/im.exec(cfg);
      // پورت SSTP همان پورت TCP سرور است (SSL-VPN / OpenVPN-TCP)
      if (proto.startsWith('tcp') && remote) tcpPort = Number(remote[1]);
    } catch { /* کانفیگ خراب — نادیده */ }
    out.push({
      hostName: cols[0], ip, countryLong: cols[5] || '', cc: (cols[6] || '').toUpperCase(), tcpPort,
    });
  }
  return out;
}

// ───────────────────────── پارس HTML ─────────────────────────
// به ساختار دقیق تگ‌ها وابسته نیست: هر سطر جدول را به متن تبدیل می‌کنیم
export function parseHtml(html, countryNames = []) {
  const names = [...countryNames].sort((a, b) => b.length - a.length);
  const out = [];
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const text = chunk.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const m = /SSTP Hostname\s*:\s*([A-Za-z0-9.-]+)(?::(\d{1,5}))?/i.exec(text);
    if (!m) continue;
    const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text)?.[1];
    if (!ip || !net.isIPv4(ip)) continue;
    const countryLong = names.find((n) => text.startsWith(n)) || '';
    out.push({ host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : 443, ip, countryLong });
  }
  return out;
}

// ───────────────────────── ساخت لیست کاندیدها ─────────────────────────
export function buildCandidates(csvRows, htmlRows) {
  const longToShort = new Map(Object.entries(COUNTRY_FALLBACK));
  const ipToCc = new Map();
  for (const r of csvRows) {
    if (r.countryLong && r.cc) longToShort.set(r.countryLong, r.cc);
    if (r.cc) ipToCc.set(r.ip, r.cc);
  }
  const map = new Map(); // کلید: ip:port
  const add = (ip, port, host, cc) => {
    const key = `${ip}:${port}`;
    const cur = map.get(key);
    if (!cur) map.set(key, { ip, port, host, cc: cc || 'XX' });
    else {
      if (host && !net.isIP(host)) cur.host = host;
      if (cc && cur.cc === 'XX') cur.cc = cc;
    }
  };
  for (const r of csvRows) {
    const host = r.hostName.includes('.') ? r.hostName.toLowerCase() : r.hostName.toLowerCase() + DOMAIN;
    const ports = r.tcpPort ? [r.tcpPort] : FALLBACK_PORTS;
    for (const p of ports) add(r.ip, p, host, r.cc);
  }
  for (const r of htmlRows) {
    const cc = ipToCc.get(r.ip) || longToShort.get(r.countryLong) || '';
    add(r.ip, r.port, r.host, cc);
  }
  return { list: [...map.values()], longToShort };
}

// ───────────────────────── تست واقعی SSTP ─────────────────────────
// SSTP روی HTTPS است: یک درخواست SSTP_DUPLEX_POST می‌فرستیم و جواب 200 با طول ویژه انتظار داریم
export function probe(c, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let buf = '';
    const sock = tls.connect({
      host: c.ip, port: c.port,
      servername: net.isIP(c.host) ? undefined : c.host,
      rejectUnauthorized: false, // گواهی سرورهای وی‌پی‌ان‌گیت خودامضاست
    });
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
    sock.on('secureConnect', () => {
      sock.write(
        'SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n' +
        `Host: ${c.host}\r\n` +
        'Content-Length: 18446744073709551615\r\n' +
        `SSTPCORRELATIONID: {${crypto.randomUUID().toUpperCase()}}\r\n\r\n`,
      );
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n') && buf.length < 4096) return;
      const ok = /^HTTP\/1\.[01] 200/i.test(buf) &&
        (/18446744073709551615/.test(buf) || /Microsoft-HTTPAPI/i.test(buf));
      finish(ok);
    });
  });
}

// ───────────────────────── اجرای اصلی ─────────────────────────
function writeHeartbeat(note) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, `${new Date().toISOString()}\n${note}\n`);
}

async function cmdScan() {
  console.log('دریافت لیست از vpngate.net ...');
  let csvRows = [], htmlRows = [];
  try { csvRows = parseCsv(await fetchText(CSV_URL)); console.log(`CSV: ${csvRows.length} سرور`); }
  catch (e) { console.log('خطا در CSV: ' + e.message); }

  const names = [...new Set([...csvRows.map((r) => r.countryLong).filter(Boolean), ...Object.keys(COUNTRY_FALLBACK)])];
  for (const u of HTML_URLS) {
    try {
      const rows = parseHtml(await fetchText(u), names);
      console.log(`HTML (${u}): ${rows.length} سرور SSTP`);
      htmlRows.push(...rows);
    } catch (e) { console.log('خطا در HTML: ' + e.message); }
  }

  const { list: targets } = buildCandidates(csvRows, htmlRows);
  if (!targets.length) {
    console.log('هیچ سروری دریافت نشد — فایل قبلی حفظ شد');
    writeHeartbeat('دریافت لیست ناموفق بود');
    return;
  }

  console.log(`شروع اسکن ${targets.length} هدف با ${CONCURRENCY} اتصال همزمان`);
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

  // یک خط برای هر IP (اگر چند هاست‌نیم یا پورت داشت، سریع‌ترین)
  alive.sort((a, b) => a.ms - b.ms);
  const seenIp = new Set();
  const lines = [];
  for (const a of alive) {
    if (seenIp.has(a.ip)) continue;
    seenIp.add(a.ip);
    const host = HOST_MODE === 'ip' ? a.ip : a.host;
    lines.push(`${host}:${a.port}:vpn:vpn:${a.cc}`);
    if (lines.length >= MAX_SAVED) break;
  }
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  writeHeartbeat(`زنده: ${alive.length}/${targets.length} — ذخیره: ${lines.length}`);
  console.log(`${lines.length} سرور در ${OUT_FILE} ذخیره شد`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cmdScan();
}
