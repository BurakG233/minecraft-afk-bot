/**
 * ═══════════════════════════════════════════════════════════
 * ADI    : proxy-lib.js
 * GÖREV  : Proxy çekme, format normalizasyonu, doğrulama ve
 *          proxy.txt yazma/okuma ortak kütüphanesi.
 *          bot.js ve update-proxies.js tarafından ortak kullanılır.
 * BAGLANTILAR:
 *   AĞ   : GitHub raw URL'leri (HTTPS GET)  → proxy listeleri
 *   AĞ   : Hedef sunucu CONFIG.host:PORT    → SOCKS5 + MC status ping doğrulama
 *   DOSYA: proxy.txt (okuma/yazma)          → çalışan proxy havuzu
 * BAĞIMLI: https (node içi), socks, fs, path
 * ═══════════════════════════════════════════════════════════
 */

const https = require('https');
const { SocksClient } = require('socks');
const fs   = require('fs');
const path = require('path');

// ─── KAYNAKLAR ──────────────────────────────────────────────────────────────
// Ücretsiz, sürekli güncellenen SOCKS proxy listeleri (düz metin).
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_type=socks5&timeout=10000&country=all',
];

const DEFAULT_TIMEOUT = 8000;

// Hedef Minecraft sürümünün protokol numarası (1.20.1 = 763).
// Status ping'te sunucunun gerçek MC protokolü konuştuğunu kanıtlamak için kullanılır.
const MC_PROTOCOL = 763;

// ─── İNDİRME ────────────────────────────────────────────────────────────────

function fetchURL(url, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error('Zaman aşımı'));
    });
  });
}

// ─── FORMAT NORMALİZASYONU ─────────────────────────────────────────────────
// Kabul edilen formatlar:
//   "socks5://ip:port"        → { host, port, type:5 }
//   "ip:port"                 → { host, port, type:5 }
//   "ip port 5"               → { host, port, type:5 }
function parseProxyLine(rawLine) {
  let line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  // 1) "ip port type"  (proxy.txt / eski format)
  const parts = line.split(/\s+/);
  if (parts.length === 3 && /^\d+$/.test(parts[1])) {
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const typeMatch = parts[2].match(/(4|5)/);
    if (host && !isNaN(port) && typeMatch) {
      return { host, port, type: parseInt(typeMatch[1], 10) };
    }
  }

  // 2) "scheme://ip:port"  (socks5://, socks4://, http://, https://)
  const schemeMatch = line.match(/^(socks5|socks4|http|https|socks5h):\/\//);
  if (schemeMatch) {
    const clean = line.replace(/^socks5h?:\/\//, '')
                      .replace(/^socks4:\/\//, '')
                      .replace(/^https?:\/\//, '');
    const hp = clean.split(':');
    if (hp.length === 2) {
      const host = hp[0];
      const port = parseInt(hp[1], 10);
      if (host && !isNaN(port) && port > 0 && port < 65536) {
        const scheme = schemeMatch[1];
        const type = (scheme === 'socks4') ? 4 : 5;
        return { host, port, type };
      }
    }
    return null;
  }

  // 3) "ip:port"
  const hp = line.split(':');
  if (hp.length === 2) {
    const host = hp[0];
    const port = parseInt(hp[1], 10);
    if (host && !isNaN(port) && port > 0 && port < 65536) {
      return { host, port, type: 5 };
    }
  }

  return null;
}

// ─── GITHUB ÇEKİMİ ─────────────────────────────────────────────────────────

async function fetchProxiesFromGithub() {
  const results = [];
  const seen = new Set();

  const tasks = PROXY_SOURCES.map(async (url) => {
    try {
      const text = await fetchURL(url);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const proxy = parseProxyLine(line);
        if (!proxy) continue;
        const key = `${proxy.host}:${proxy.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(proxy);
      }
      return { url, ok: true, count: lines.length };
    } catch (err) {
      return { url, ok: false, count: 0 };
    }
  });

  const statuses = await Promise.all(tasks);
  const totalRaw = statuses.reduce((acc, s) => acc + s.count, 0);

  return { proxies: results, totalRaw, statuses };
}

// ─── DOĞRULAMA ─────────────────────────────────────────────────────────────

function verifyProxy(proxy, host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: proxy.type || 5 },
      command: 'connect',
      destination: { host, port },
      timeout,
    }).then((info) => {
      info.socket.destroy();
      resolve(true);
    }).catch(() => {
      resolve(false);
    });
  });
}

async function verifyProxies(proxies, host, port, timeout = DEFAULT_TIMEOUT, onProgress = null) {
  const working = [];
  const chunkSize = 25;
  let done = 0;

  for (let i = 0; i < proxies.length; i += chunkSize) {
    const chunk = proxies.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map((p) => verifyProxy(p, host, port, timeout)));
    results.forEach((ok, idx) => {
      if (ok) working.push(chunk[idx]);
    });
    done += chunk.length;
    if (onProgress) onProgress(done, proxies.length, working.length);
  }

  return working;
}

// ─── MINECRAFT STATUS PING (GERÇEK PROTOKOL DOĞRULAMASI) ─────────────────────
// Sadece "TCP bağlantı kuruldu" yetmez; artık proxy üzerinden gerçek bir
// Minecraft status isteği (handshake + ping + JSON) yapıyoruz. Proxy MC dışı
// çöp/HTTP baytı sızdırırsa JSON.parse başarısız olur → proxy elenir.
// Böylece bot.js'in framing/compression çökmelerinin önüne geçilir.

function writeVarInt(value) {
  const out = [];
  while (value & ~0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
  return Buffer.from(out);
}

function readVarInt(buf, offset = 0) {
  let value = 0, pos = 0;
  let b;
  do {
    if (offset >= buf.length || pos > 5) throw new Error('Kötü varint');
    b = buf[offset++];
    value |= (b & 0x7f) << (pos * 7);
    pos++;
  } while (b & 0x80);
  return { value, size: pos };
}

function makeSocketReader(socket) {
  // Data eventlerini tamponlar; ardışık 'read(n)' çağrılarına baytları dağıtır.
  let buf = Buffer.alloc(0);
  let ended = false;
  let error = null;
  const pending = [];

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  socket.on('end', () => { ended = true; pump(); });
  socket.on('error', (e) => { error = e; pump(); });

  function pump() {
    while (pending.length) {
      const req = pending[0];
      if (buf.length >= req.n) {
        pending.shift();
        req.resolve(buf.slice(0, req.n));
        buf = buf.slice(req.n);
      } else if (ended || error) {
        pending.shift();
        req.reject(error || new Error('Bağlantı kapandı'));
      } else {
        break;
      }
    }
  }

  return {
    read(n) {
      return new Promise((resolve, reject) => {
        pending.push({ n, resolve, reject });
        pump();
      });
    },
  };
}

async function readVarIntFromReader(reader) {
  let value = 0, pos = 0, b;
  do {
    const chunk = await reader.read(1);
    b = chunk[0];
    value |= (b & 0x7f) << (pos * 7);
    pos++;
    if (pos > 5) throw new Error('Kötü varint');
  } while (b & 0x80);
  return value;
}

async function minecraftStatusPing(socket, host, port, proto = MC_PROTOCOL) {
  // Handshake paketi (next_state = 1 → status)
  const addr = Buffer.from(host, 'utf8');
  const handshakePayload = Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(proto),
    writeVarInt(addr.length), addr,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1),
  ]);
  // Status request: paket id 0x00, boş payload
  const statusRequest = Buffer.from([0x00]);

  const handshakeFrame = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload]);
  const statusFrame = Buffer.concat([writeVarInt(statusRequest.length), statusRequest]);
  socket.write(Buffer.concat([handshakeFrame, statusFrame]));

  const reader = makeSocketReader(socket);
  const frameLen = await readVarIntFromReader(reader);
  if (frameLen <= 0 || frameLen > 65535) throw new Error('Geçersiz çerçeve boyu');
  const payload = await reader.read(frameLen);
  const { value: pid, size } = readVarInt(payload, 0);
  if (pid !== 0x00) throw new Error('Beklenmeyen paket: ' + pid);
  // Modern status yanıtı: packet_id + string_uzunluğu(varint) + JSON baytları
  const { value: slen, size: ssize } = readVarInt(payload, size);
  if (size + ssize + slen > payload.length) throw new Error('Kısa JSON gövdesi');
  const raw = payload.slice(size + ssize, size + ssize + slen).toString('utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('MC JSON cevabı gelmedi');
  return obj;
}

function measureProxyMinecraft(proxy, host, port, timeout = DEFAULT_TIMEOUT, proto = MC_PROTOCOL) {
  // verifyProxyMinecraft ile aynı test + geçen süre (ms) ölçümü.
  // Süre = SOCKS bağlanma + MC status ping toplamı → proxy'nin yük/trafik
  // durumunu gösteren bütünsel kalite metriği (düşük = sakin/boş proxy).
  return new Promise((resolve) => {
    const t0 = Date.now();
    let socket = null;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - t0 : -1 });
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeout);

    SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: proxy.type || 5 },
      command: 'connect',
      destination: { host, port },
      timeout,
    }).then((info) => {
      if (settled) {
        // Zaman aşımı çoktan dolmuştu: geç gelen soketi sızdırmadan kapat
        try { info.socket.destroy(); } catch (_) {}
        return;
      }
      socket = info.socket;
      minecraftStatusPing(socket, host, port, proto)
        .then(() => finish(true))
        .catch(() => finish(false));
    }).catch(() => {
      finish(false);
    });
  });
}

function verifyProxyMinecraft(proxy, host, port, timeout = DEFAULT_TIMEOUT, proto = MC_PROTOCOL) {
  return measureProxyMinecraft(proxy, host, port, timeout, proto).then((r) => r.ok);
}

async function verifyProxiesMeasured(proxies, host, port, timeout = DEFAULT_TIMEOUT, onProgress = null, proto = MC_PROTOCOL) {
  // Geçenleri { proxy, latencyMs } olarak döndürür (sıralama çağrana ait)
  const passed = [];
  const chunkSize = 25;
  let done = 0;

  for (let i = 0; i < proxies.length; i += chunkSize) {
    const chunk = proxies.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map((p) => measureProxyMinecraft(p, host, port, timeout, proto)));
    results.forEach((r, idx) => {
      if (r.ok) passed.push({ proxy: chunk[idx], latencyMs: r.latencyMs });
    });
    done += chunk.length;
    if (onProgress) onProgress(done, proxies.length, passed.length);
  }

  return passed;
}

async function verifyProxiesMinecraft(proxies, host, port, timeout = DEFAULT_TIMEOUT, onProgress = null, proto = MC_PROTOCOL) {
  const passed = await verifyProxiesMeasured(proxies, host, port, timeout, onProgress, proto);
  return passed.map((x) => x.proxy);
}

// ─── DOSYA İŞLEMLERİ ───────────────────────────────────────────────────────

function proxyFilePath(dir) {
  return path.join(dir, 'proxy.txt');
}

function writeProxyFile(dir, proxies) {
  const filePath = proxyFilePath(dir);
  const lines = proxies.map((p) => `${p.host} ${p.port} ${p.type || 5}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

function loadProxyFile(dir) {
  const filePath = proxyFilePath(dir);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const proxies = [];
  for (const line of lines) {
    const p = parseProxyLine(line);
    if (p) proxies.push(p);
  }
  return proxies;
}

function getRandomSubarray(arr, n) {
  const shuffled = arr.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

module.exports = {
  PROXY_SOURCES,
  parseProxyLine,
  fetchURL,
  fetchProxiesFromGithub,
  verifyProxy,
  verifyProxies,
  verifyProxyMinecraft,
  verifyProxiesMinecraft,
  measureProxyMinecraft,
  verifyProxiesMeasured,
  MC_PROTOCOL,
  writeProxyFile,
  loadProxyFile,
  proxyFilePath,
  getRandomSubarray,
};