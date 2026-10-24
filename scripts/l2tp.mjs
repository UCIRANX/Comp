// scripts/l2tp.mjs  —  استفاده:  node scripts/l2tp.mjs
// Node 20+ ، بدون وابستگی خارجی
// کار: دریافت لیست vpngate.net و ipspeed.info ← حذف تکراری‌ها ← نوشتن همه سرورها در UcL2tp.txt (بدون اسکن)
// فرمت هر خط:  L2TP:server:port:username:password:psk:name:country
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ───────────────────────── تنظیمات ─────────────────────────
const OUT_FILE = process.env.OUT_FILE || 'UcL2tp.txt';
const DATA_DIR = 'data';
const HEARTBEAT_FILE = path.join(DATA_DIR, 'l2tp-heartbeat.txt'); // هر اجرا عوض می‌شود تا ریپو فعال بماند
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
// فقط سطرهایی که ستون L2TP/IPsec دارند (در سطر خام کلمه l2tp هست) و هاست‌نیم opengw.net و IP دارند
export function parseVpngateHtml(html, countryNames = []) {
  const names = [...countryNames].sort((a, b) => b.length - a.length);
  const out = [];
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    if (!/l2tp/i.test(chunk)) continue; // سرور بدون L2TP
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
  // CSV فلگ L2TP ندارد؛ فقط برای پیدا کردن کد کشور و هاست‌نیم از روی IP استفاده می‌شود
  const longToShort = new Map(Object.entries(COUNTRY_FALLBACK));
  const ipToCc = new Map();
  const ipToHost = new Map();
  for (const r of csvRows) {
    if (r.countryLong && r.cc) longToShort.set(r.countryLong, r.cc);
    if (r.cc) ipToCc.set(r.ip, r.cc);
    const h = r.hostName.toLowerCase();
    ipToHost.set(r.ip, h.includes('.') ? h : h + DOMAIN);
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
  for (const r of vgRows) add(r.ip, r.host, ipToCc.get(r.ip) || longToShort.get(r.countryLong));
  for (const r of ipsRows) add(r.ip, ipToHost.get(r.ip) || '', ipToCc.get(r.ip) || longToShort.get(r.countryLong));
  return [...map.values()];
}

// ───────────────────────── خروجی ─────────────────────────
// هر سرور: خط هاست‌نیم و درست زیرش خط آی‌پی (اگر هاست‌نیم نداشت فقط آی‌پی). نام‌ها پشت‌سرهم شماره می‌خورند
export function formatLines(list) {
  const lines = [];
  let n = 0, servers = 0;
  const line = (server, cc) => `L2TP:${server}::vpn:vpn:vpn:${NAME_PREFIX}${++n}:${cc}`;
  for (const a of list) {
    if (a.host) lines.push(line(a.host, a.cc));
    lines.push(line(a.ip, a.cc));
    servers++;
  }
  return { lines, servers };
}

function writeHeartbeat(note) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, `${new Date().toISOString()}\n${note}\n`);
}

async function cmdRun() {
  console.log('دریافت لیست‌ها ...');
  let csvRows = [], vgRows = [], ipsRows = [];
  try { csvRows = parseCsv(await fetchText(CSV_URL)); console.log(`vpngate CSV: ${csvRows.length} سرور (فقط برای کشور/هاست‌نیم)`); }
  catch (e) { console.log('خطا در CSV: ' + e.message); }

  const names = [...new Set([...csvRows.map((r) => r.countryLong).filter(Boolean), ...Object.keys(COUNTRY_FALLBACK)])];
  try { vgRows = parseVpngateHtml(await fetchText(VPNGATE_HTML), names); console.log(`vpngate HTML: ${vgRows.length} سرور دارای L2TP`); }
  catch (e) { console.log('خطا در HTML وی‌پی‌ان‌گیت: ' + e.message); }

  try { ipsRows = parseIpspeed(await fetchText(IPSPEED_URL, BROWSER_UA, 2)); console.log(`ipspeed: ${ipsRows.length} سرور`); }
  catch (e) { console.log('ipspeed در دسترس نبود (رد شد): ' + e.message); }

  const targets = buildCandidates(csvRows, vgRows, ipsRows);
  if (!targets.length) {
    console.log('هیچ سرور L2TP پیدا نشد — فایل قبلی حفظ شد');
    writeHeartbeat('هیچ سرور L2TP پیدا نشد');
    return;
  }

  const { lines, servers } = formatLines(targets);
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  writeHeartbeat(`ذخیره: ${servers} سرور (${lines.length} خط)`);
  console.log(`${servers} سرور (${lines.length} خط) در ${OUT_FILE} ذخیره شد`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cmdRun();
}
