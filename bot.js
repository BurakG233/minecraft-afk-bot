/**
 * ═══════════════════════════════════════════════════════════
 * ADI    : bot.js
 * GÖREV  : Minecraft AFK botu — hesap seçici, proxy yönetimi,
 *          hesap başına farklı IP dağıtımı ve otomatik
 *          proxy geçişi (failover) ile bağlantı sürdürme.
 * BAGLANTILAR:
 *   AĞ   : Sunucu     → CONFIG.host:CONFIG.port (Minecraft)
 *   AĞ   : Proxy      → SOCKS5 üzerinden sunucuya bağlanır
 *   AĞ   : Proxy kynk → proxy-lib.js (GitHub HTTPS GET)
 *   DOSYA: hesaplar.json  (okuma/yazma — hesap listesi)
 *   DOSYA: proxy.txt      (okuma/yazma — çalışan proxy havuzu)
 *   DOSYA: proxy-mode.json (okuma/yazma — son dağıtım modu)
 *   DOSYA: proxy-stats.json (yazma — toplama modu ping istatistiği)
 *   DOSYA: chat.log       (yazma — sohbet geçmişi)
 * KULLANIM: node bot.js  (etkileşimli) | node bot.js --proxy-only [adet] [--max-ping=ms]
 * BAĞIMLI: mineflayer, socks, proxy-lib.js (node içi https/fs/path/readline)
 * ═══════════════════════════════════════════════════════════
 */

const mineflayer = require('mineflayer');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');
const proxyLib   = require('./proxy-lib.js');

// ─── AYARLAR ─────────────────────────────────────────────────────────────────
const CONFIG = {
  host:           'mc.atlasoyuncu.com',
  port:           25565,
  version:        '1.20.1',
  username:       'BurakG2', // Dinamik olarak hesaplar.json'dan gelecek
  auth:           'offline',
  reconnect:      true,
  reconnectDelay: 10,
  logFile:        'chat.log',

  proxy: {
    enabled:        true,   // proxy sistemi açık/kapalı
    autoFetch:      true,   // açılışta GitHub'dan taze listeyi çek + doğrula
    mode:           'ask',  // 'single' | 'per-account' | 'per-2' | 'per-4' | 'direct' | 'ask'
                            // 'ask' ise açılışta sorulur, son seçim hatırlanır
    maxFailovers:   3,      // proxy ölünce hesap başına kaç proxy denenecek
    verifyTimeout:  7000,   // proxy doğrulama zaman aşımı (ms)
    verifyLimit:    300,    // açılışta doğrulanacak max proxy (havuz örneklenecek)
    blacklist:      true,   // ölen proxy'yi oturum boyunca kara listeye al
  },

  authPassword: '',
  autoChat: {
    enabled:         false,
    message:         'Merhaba!',
    intervalSeconds: 300,
  },
};
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
  bgBlue: '\x1b[44m',
  magenta: '\x1b[35m',
};

let bot            = null;
let bots           = [];
let rl             = null;
let consoleStarted = false;
let reconnectTimer = null;
let isConnected    = false;
let chatHistory    = [];
const MAX_HISTORY  = 100;
let isMining       = false;
let miningTimer    = null;
let isAfk          = false;
let afkTimer       = null;
let selectedAccounts = [];

// ─── PROXY DURUMU ────────────────────────────────────────────────────────────
let proxyPool       = [];   // doğrulanmış çalışan proxy havuzu
let proxyBlacklist  = new Set(); // ölen proxy'ler (oturum boyunca)
let proxyMode       = 'single'; // dağıtım modu
let proxyIndexRef   = 0;    // round-robin sayaç
let proxyVerifyLimit = 300; // açılışta doğrulanacak proxy sayısı (kayıtlı)

// ─── OTOMATİK GİRİŞ DURUMU (hesap başına) ─────────────────────────────────────
const MAX_AUTH_ATTEMPTS = 10000;
const AUTH_COOLDOWN_MS  = 3000;
let authPasswords     = {};   // kullanıcı adı → şifre (auth-passwords.json, kalıcı)
let authFailGroup     = [];   // şifreyi yanlış verip vazgeçen hesaplar (/toplu için)

let autoChatTimer = null;

// ─── YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────────

function timestamp() {
  return new Date().toLocaleTimeString('tr-TR');
}

function log(type, msg) {
  const colors = {
    INFO:  C.cyan,
    CHAT:  C.white,
    WARN:  C.yellow,
    ERROR: C.red,
    SYS:   C.green,
    BOT:   C.bgBlue + C.white,
  };
  const col = colors[type] || C.white;
  const line = `${C.gray}[${timestamp()}]${C.reset} ${col}[${type}]${C.reset} ${msg}`;
  console.log(line);

  if (CONFIG.logFile && (type === 'CHAT' || type === 'BOT')) {
    const raw = `[${timestamp()}] [${type}] ${msg}\n`;
    fs.appendFileSync(CONFIG.logFile, raw, 'utf8');
  }
}

function banner() {
  console.clear();
  console.log(`${C.green}${C.bold}
╔═══════════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                       G233   AFK Bot v1.1                                             ║
║                                                                                                       ║
╠═══════════════════════════════════════════════════════════════════════════════════════════════════════╣
║  Komutlar:                                                                                            ║
║  /msg <mesaj>  → Chat mesajı gönder                     HAREKET KOMUTLARI (2 blok):                   ║
║  /cmd <komut>  → Sunucu komutu çalıştır                 /ileri        → 2 blok ileri git              ║
║  /mine         → Aralıksız madencilik                   /geri         → 2 blok geri git               ║
║  /stop         → Madencilik durdur                      /sag          → 2 blok sağa git               ║
║  /afk          → AFK modu toggle                        /sol          → 2 blok sola git               ║
║                                                                                                       ║
║  ENVANTER DROP (ilk 9 slot):                            OTOMATİK SOHBET KOMUTLARI:                    ║
║  /drop slot N  → N. slottaki itemi at (1-9)             /setpass <şifre>   → Tüm seçili hesaplara     ║
║  /drop all     → İlk 9 slottaki her şeyi at             /setpass <hesap> <şifre> → Tek hesaba         ║
║                                                         /setpass all <şifre> → Tüm hesaplara          ║
║                                                         /toplu <şifre>     → Giriş yapamayan gruba    ║
║                                                         /pass              → Şifre eşlemesi           ║
║                                                         /proxycount <N>    → Doğrulama proxy adedi    ║
║                                                         /autochat <sn> <msg> → Otomatik döngü         ║
║                                                         /autochat stop    → Döngüyü durdur            ║
╠═══════════════════════════════════════════════════════════════════════════════════════════════════════╣
║   /info         → Bot bilgilerini göster                                                              ║
║   /proxies      → Aktif proxy/IP haritasını göster                                                    ║
║   /history      → Son 20 chat mesajı                                                                  ║
║   /hesap        → Hesap değiştir                                                                      ║
║   /reconnect    → Yeniden bağlan                                                                      ║
║   /quit         → Botu kapat                                                                          ║
╚═══════════════════════════════════════════════════════════════════════════════════════════════════════╝
${C.reset}`);
}

// ─── HESAPLAR.JSON YÖNETIMI ──────────────────────────────────────────────────

function loadAccounts() {
  const filePath = path.join(__dirname, 'hesaplar.json');
  
  if (!fs.existsSync(filePath)) {
    log('WARN', `hesaplar.json bulunamadı, örnek dosya oluşturuluyor...`);
    
    const template = {
      "accounts": [
        {
          "id": 1,
          "username": "OyuncuAdi1",
          "description": "Ana hesap"
        },
        {
          "id": 2,
          "username": "OyuncuAdi2",
          "description": "AFK hesabı"
        },
        {
          "id": 3,
          "username": "OyuncuAdi3",
          "description": "Yedek hesap"
        }
      ]
    };
    
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf8');
    log('SYS', `${C.green}✔ hesaplar.json oluşturuldu. Lütfen hesaplarınızı düzenleyin.${C.reset}`);
    return template.accounts;
  }

  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(data);
    return json.accounts || [];
  } catch (err) {
    log('ERROR', `hesaplar.json okunamadı: ${err.message}`);
    return [];
  }
}

function saveAccounts(accounts) {
  const filePath = path.join(__dirname, 'hesaplar.json');
  const json = { accounts };
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
}

function ensureReadline() {
  if (!rl) {
    rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

function getConnectedBots() {
  return bots.filter((entry) => entry && entry.bot && entry.connected);
}

function forEachConnectedBot(callback) {
  getConnectedBots().forEach((entry) => callback(entry));
}

function isAnyBotConnected() {
  return getConnectedBots().length > 0;
}

function stopAllBotTimers() {
  bots.forEach((entry) => {
    if (entry && entry.miningTimer) {
      clearTimeout(entry.miningTimer);
      entry.miningTimer = null;
    }
    if (entry && entry.afkTimer) {
      clearTimeout(entry.afkTimer);
      entry.afkTimer = null;
    }
    if (entry) {
      entry.isMining = false;
      entry.isAfk = false;
    }
  });

  if (autoChatTimer) {
    clearInterval(autoChatTimer);
    autoChatTimer = null;
  }
  isMining = false;
  isAfk = false;
}

function disconnectAllBots() {
  stopAllBotTimers();
  cancelAllFailovers(); // bekleyen otomatik yeniden-bağlanmaları iptal et (hayalet bot önlenir)
  isMining = false;
  isAfk = false;
  isConnected = false;

  bots.forEach((entry) => {
    if (entry && entry.bot) {
      // Listener'lar ÖNCE sökülür: kasıtlı kapatma 'end' handler'ını
      // tetikleyip gereksiz failover + kara liste kirlenmesine yol açmasın
      try { entry.bot.removeAllListeners(); } catch (_) {}
      try { entry.bot.end(); } catch (_) {}
    }
  });
  bots = [];
  bot = null;
}

function chooseAccountAndStart() {
  const accounts = loadAccounts();

  if (!accounts || accounts.length === 0) {
    log('ERROR', 'hesaplar.json dosyasında hesap bulunamadı!');
    process.exit(1);
  }

  console.log(`\n${C.magenta}${C.bold}── Hesap Seçimi ──────────────────────────────────${C.reset}`);
  accounts.forEach((acc) => {
    console.log(`  ${C.bold}${acc.id}${C.reset}. ${C.cyan}${acc.username}${C.reset} ${C.dim}(${acc.description || 'Açıklama yok'})${C.reset}`);
  });
  console.log(`  ${C.bold}0${C.reset}. ${C.magenta}ALL${C.reset} - Tüm hesapları aynı anda başlat`);
  console.log(`  ${C.bold}P${C.reset}. ${C.magenta}PROXY${C.reset} - Sadece proxy topla/test et (bot başlatılmaz)`);
  console.log(`${C.magenta}────────────────────────────────────────────────────${C.reset}`);

  ensureReadline();

  rl.question(`${C.magenta}Hangi hesabı kullanmak istiyorsunuz? (1-${accounts.length}, all veya P): ${C.reset}`, (answer) => {
    const choiceText = answer.trim().toLowerCase();

    if (choiceText === 'p' || choiceText === 'proxy') {
      rl.question(`${C.green}Kaç kaliteli proxy toplansın?${C.reset} ${C.dim}(boş = 30)${C.reset}: `, (numAnswer) => {
        const n = parseInt(numAnswer.trim(), 10);
        runProxyOnly(!isNaN(n) && n >= 1 && n <= 500 ? n : 30, 4000).catch((err) => {
          log('ERROR', 'Proxy toplama hatası: ' + err.message);
          process.exit(1);
        });
      });
      return;
    }

    if (choiceText === 'all' || choiceText === 'a' || choiceText === '0') {
      selectedAccounts = accounts;
      log('SYS', `${C.green}✔ Tüm ${selectedAccounts.length} hesap aynı anda başlatılacak.${C.reset}`);
      chooseProxyAndStart(selectedAccounts);
      return;
    }

    const choice = parseInt(choiceText, 10);
    const selected = accounts.find(acc => acc.id === choice);

    if (!selected) {
      log('ERROR', 'Geçersiz seçim!');
      process.exit(1);
    }

    CONFIG.username = selected.username;
    selectedAccounts = [selected];
    log('SYS', `${C.green}✔ Seçilen hesap:${C.reset} ${C.bold}${selected.username}${C.reset}`);

    if (selected.description) {
      log('SYS', `${C.dim}(${selected.description})${C.reset}`);
    }

    chooseProxyAndStart(selectedAccounts);
  });
}

// ─── PROXY SİSTEMİ ──────────────────────────────────────────────────────────

function modName(mode) {
  return mode === 'per-account' ? 'Her hesaba farklı proxy'
       : mode === 'per-2'      ? 'Her 2 hesaba 1 proxy'
       : mode === 'per-4'      ? 'Her 4 hesaba 1 proxy'
       : mode === 'direct'     ? 'Proxysiz (direkt bağlan)'
       : 'Tek proxy';
}

function proxyModeFilePath() {
  return path.join(__dirname, 'proxy-mode.json');
}

function loadProxyConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(proxyModeFilePath(), 'utf8'));
    return { mode: d.mode || 'single', limit: d.limit || 300 };
  } catch (_) {
    return { mode: 'single', limit: 300 };
  }
}

function loadProxyMode() {
  return loadProxyConfig().mode;
}

function saveProxyConfig(mode, limit) {
  try {
    fs.writeFileSync(proxyModeFilePath(), JSON.stringify(
      { mode: mode || proxyMode, limit: limit || proxyVerifyLimit, savedAt: new Date().toISOString() },
      null, 2), 'utf8');
  } catch (_) {}
}

function saveProxyMode(mode) {
  // Geri uyumluluk: sadece modu günceller, limiti korur
  saveProxyConfig(mode, proxyVerifyLimit);
}

async function loadAndVerifyProxies() {
  // Önce proxy.txt'deki bilinen proxy'leri doğrula; yetmezse GitHub'dan taze çekip ekle
  const seed = proxyLib.loadProxyFile(__dirname);
  log('SYS', `${C.cyan}Doğrulama başlıyor${C.reset} ${C.dim}(hedef: ${proxyVerifyLimit} çalışan proxy — önce ${seed.length} kayıtlı aday)${C.reset}`);

  const working = [];
  const verify = async (list) => {
    if (list.length === 0) return;
    const found = await proxyLib.verifyProxiesMinecraft(list, CONFIG.host, CONFIG.port, CONFIG.proxy.verifyTimeout, (done, total, ok) => {
      log('SYS', `Doğrulama: ${done}/${total} tarandı, ${C.green}${ok}${C.reset} çalışan`);
    });
    found.forEach((p) => {
      if (!working.some((w) => w.host === p.host && w.port === p.port)) working.push(p);
    });
  };

  if (seed.length > 0) {
    await verify(seed);
    if (working.length >= proxyVerifyLimit) {
      log('SYS', `${C.green}✔ Yeterli çalışan proxy var (${working.length}), GitHub çekimi atlandı.${C.reset}`);
      return working;
    }
  }

  const need = proxyVerifyLimit - working.length;

  if (!CONFIG.proxy.autoFetch) {
    if (working.length > 0) {
      const f = proxyLib.writeProxyFile(__dirname, working);
      log('SYS', `${C.green}✔ ${working.length} çalışan proxy (autoFetch kapalı) → ${path.basename(f)} kaydedildi.${C.reset}`);
    }
    return working;
  }

  log('SYS', `${C.cyan}Eksik var: ${need} proxy daha... GitHub kaynaklarından taze liste çekiliyor.${C.reset}`);
  const { proxies: raw, totalRaw } = await proxyLib.fetchProxiesFromGithub();
  log('SYS', `İndirilen proxy (tekrarsız): ${C.bold}${raw.length}${C.reset} (toplam satır: ${totalRaw})`);

  // GitHub'dan da seed'dekilerle çakışmayan yeterli miktarı örnekle
  const known = new Set(seed.map((p) => `${p.host}:${p.port}`));
  const candidates = raw.filter((p) => !known.has(`${p.host}:${p.port}`));
  const pool = proxyLib.getRandomSubarray(candidates, Math.min(candidates.length, Math.ceil(need * 2)));
  log('SYS', `GitHub'dan seçildi: ${C.bold}${pool.length}${C.reset} proxy → ${CONFIG.host}:${CONFIG.port}`);

  await verify(pool);

  if (working.length > 0) {
    const f = proxyLib.writeProxyFile(__dirname, working);
    log('SYS', `${C.green}✔ Toplam ${working.length} çalışan proxy → ${path.basename(f)} kaydedildi.${C.reset}`);
  } else {
    log('WARN', 'Hiç çalışan proxy bulunamadı.');
  }
  return working;
}

// ─── SADECE PROXY TOPLAMA MODU ───────────────────────────────────────────────
// Bot başlatılmaz: proxy.txt + GitHub adayları çift turlu MC-ping'den geçer,
// iki turu da geçen + pingi eşik altındaki "sakin" proxy'ler hıza göre
// sıralanıp proxy.txt'ye yazılır (en hızlı en üstte → normal mod da yararlanır).
// Kullanım: hesap menüsünde "P" veya: node bot.js --proxy-only [adet] [--max-ping=ms]

function proxyStatsPath() {
  return path.join(__dirname, 'proxy-stats.json');
}

async function runProxyOnly(target = 30, maxLatency = 4000) {
  log('SYS', `${C.cyan}Proxy toplama modu${C.reset} ${C.dim}(hedef: ${target} kaliteli proxy, max ping: ${maxLatency}ms, bot başlatılmayacak)${C.reset}`);
  const latencies = new Map(); // "host:port" → { proxy, pings: [] }

  const testBatch = async (list, round) => {
    if (list.length === 0) return 0;
    const measured = await proxyLib.verifyProxiesMeasured(list, CONFIG.host, CONFIG.port, CONFIG.proxy.verifyTimeout, (done, total, ok) => {
      log('SYS', `${round}. tur: ${done}/${total} tarandı, ${C.green}${ok}${C.reset} geçti`);
    });
    measured.forEach(({ proxy, latencyMs }) => {
      const key = `${proxy.host}:${proxy.port}`;
      if (!latencies.has(key)) latencies.set(key, { proxy, pings: [] });
      latencies.get(key).pings.push(latencyMs);
    });
    return measured.length;
  };

  // 1. tur: önce kayıtlı adaylar
  const seed = proxyLib.loadProxyFile(__dirname);
  log('SYS', `1. tur: ${seed.length} kayıtlı aday test ediliyor...`);
  let round1pass = await testBatch(seed, 1);

  // Hedefe ulaşana kadar GitHub'dan partiler halinde taze aday
  if (round1pass < target && CONFIG.proxy.autoFetch) {
    const { proxies: raw, totalRaw } = await proxyLib.fetchProxiesFromGithub();
    log('SYS', `İndirilen proxy (tekrarsız): ${C.bold}${raw.length}${C.reset} (toplam satır: ${totalRaw})`);
    const known = new Set([...seed.map((p) => `${p.host}:${p.port}`), ...latencies.keys()]);
    const fresh = raw.filter((p) => !known.has(`${p.host}:${p.port}`));
    for (let i = 0; i < fresh.length && round1pass < target; i += 60) {
      const batch = fresh.slice(i, i + 60);
      log('SYS', `1. tur: GitHub partisinden ${batch.length} aday test ediliyor...`);
      round1pass += await testBatch(batch, 1);
    }
  }

  // 2. tur (stabilite): 1. turu geçenler TEKRAR ölçülür — tek seferlik
  // şans eseri geçenler ("ölmek üzere olan" proxy'ler) burada elenir
  const round1 = [...latencies.values()].filter((v) => v.pings.length >= 1).map((v) => v.proxy);
  log('SYS', `2. tur (stabilite): ${round1.length} aday tekrar test ediliyor...`);
  await testBatch(round1, 2);

  const stable = [...latencies.values()]
    .filter((v) => v.pings.length >= 2) // iki turu da geçti
    .map((v) => ({ proxy: v.proxy, avgMs: Math.round((v.pings[0] + v.pings[1]) / 2) }))
    .filter((x) => x.avgMs <= maxLatency) // yoğun/yavaş olanlar elenir
    .sort((a, b) => a.avgMs - b.avgMs)
    .slice(0, target);

  if (stable.length === 0) {
    log('ERROR', 'Kalite barajını geçen proxy bulunamadı (çift tur + ping eşiği). proxy.txt değiştirilmedi.');
    process.exit(1);
  }

  const sorted = stable.map((x) => x.proxy);
  const f = proxyLib.writeProxyFile(__dirname, sorted);
  try {
    fs.writeFileSync(proxyStatsPath(), JSON.stringify({
      checkedAt: new Date().toISOString(),
      target, maxLatencyMs: maxLatency,
      count: stable.length,
      proxies: stable.map((x) => ({ host: x.proxy.host, port: x.proxy.port, type: x.proxy.type || 5, avgMs: x.avgMs })),
    }, null, 2), 'utf8');
  } catch (_) {}

  console.log(`\n${C.cyan}── Kaliteli Proxy'ler ${C.dim}(${stable.length} adet, hıza göre)${C.reset}`);
  stable.forEach((x, i) => {
    console.log(`  ${C.bold}${String(i + 1).padStart(2)}.${C.reset} ${x.proxy.host}:${x.proxy.port}  ${C.green}${x.avgMs}ms${C.reset}`);
  });
  console.log(`${C.cyan}───────────────────────────────────────────${C.reset}\n`);
  log('SYS', `${C.green}✔ ${stable.length} kaliteli proxy → ${path.basename(f)} (+ proxy-stats.json) kaydedildi. Bot başlatılmadı.${C.reset}`);
  process.exit(0);
}

function parseProxyOnlyArgs(argv) {
  const i = argv.findIndex((a) => a === '--proxy-only' || a.startsWith('--proxy-only='));
  if (i === -1) return null;
  let target = 30;
  const eq = argv[i].match(/^--proxy-only=(\d+)$/);
  if (eq) {
    target = parseInt(eq[1], 10);
  } else if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) {
    target = parseInt(argv[i + 1], 10);
  }
  target = Math.min(Math.max(target || 30, 1), 500);
  let maxLatency = 4000;
  const j = argv.findIndex((a) => a.startsWith('--max-ping='));
  if (j !== -1) {
    const m = parseInt(argv[j].split('=')[1], 10);
    if (!isNaN(m) && m >= 500 && m <= 15000) maxLatency = m;
  }
  return { target, maxLatency };
}

function assignProxies(accounts, proxies, mode) {
  // Kara listedekiler (bu oturumda ölmüş) dağıtımda atlanır;
  // hepsi karalistedeyse yine de dener (boş proxy'dense failover şansı verir)
  const usable = proxies.filter((p) => !proxyBlacklist.has(`${p.host}:${p.port}`));
  const pool = usable.length > 0 ? usable : proxies;
  return accounts.map((acc, i) => {
    let proxy = null;
    if (mode === 'per-account') {
      proxy = pool[i % pool.length];
    } else if (mode === 'per-2') {
      proxy = pool[Math.floor(i / 2) % pool.length];
    } else if (mode === 'per-4') {
      proxy = pool[Math.floor(i / 4) % pool.length];
    } else { // single
      proxy = pool[0];
    }
    return { ...acc, proxy };
  });
}

function getNextWorkingProxy() {
  if (proxyPool.length === 0) return null;
  for (let i = 0; i < proxyPool.length; i++) {
    proxyIndexRef = (proxyIndexRef + 1) % proxyPool.length;
    const p = proxyPool[proxyIndexRef];
    if (!proxyBlacklist.has(`${p.host}:${p.port}`)) return p;
  }
  return null;
}

const failoverLock = new Set();
const failoverTimers = new Map(); // username → setTimeout id (iptal edilebilir yeniden-bağlanma)

// Kasıtlı koparmalarda (/hesap, /reconnect, /quit) bekleyen failover'ları iptal eder
function cancelAllFailovers() {
  failoverTimers.forEach((id) => clearTimeout(id));
  failoverTimers.clear();
  failoverLock.clear();
}

function handleProxyFailover(account, failoversLeft, err) {
  const key = account.username || 'anon';
  if (failoverLock.has(key)) {
    log('WARN', `${key}: failover zaten sürüyor, atlanıyor.`);
    return;
  }
  if (failoversLeft <= 0) {
    log('ERROR', `${account.username || '?'}: ${C.red}proxy denemeleri bitti, beklemeye alındı.${C.reset}`);
    return;
  }
  failoverLock.add(key);
  if (CONFIG.proxy.blacklist && account.proxy) {
    proxyBlacklist.add(`${account.proxy.host}:${account.proxy.port}`);
    log('WARN', `${account.username || '?'}: kara liste → ${account.proxy.host}:${account.proxy.port}`);
  }
  const next = getNextWorkingProxy();
  if (!next) {
    failoverLock.delete(key);
    log('ERROR', `${account.username || '?'}: ${C.red}kullanılabilir proxy kalmadı.${C.reset}`);
    return;
  }
  account.proxy = next;
  account.failoversLeft = failoversLeft - 1;
  log('WARN', `${account.username || '?'}: "${err.message}" → yeni proxy ${C.bold}${next.host}:${next.port}${C.reset} (kalan deneme: ${failoversLeft - 1})`);
  if (failoverTimers.has(key)) clearTimeout(failoverTimers.get(key));
  const tid = setTimeout(() => {
    failoverTimers.delete(key);
    failoverLock.delete(key);
    log('SYS', `${account.username || '?'}: yeni proxy ile yeniden bağlanılıyor...`);
    createBot(account);
  }, 1200);
  failoverTimers.set(key, tid);
}

async function startWithProxies(accounts) {
  if (!CONFIG.proxy.enabled || proxyMode === 'direct') {
    log('SYS', 'Proxysiz moda geçildi, doğrudan bağlanılıyor.');
    proxyPool = [];
    startAccounts(accounts);
    return;
  }

  proxyPool = await loadAndVerifyProxies();

  if (proxyPool.length === 0) {
    log('WARN', `${C.yellow}Çalışan proxy bulunamadı, proxysiz bağlanılıyor.${C.reset}`);
    startAccounts(accounts);
    return;
  }

  log('SYS', `${C.green}✔ Proxy havuzu hazır: ${proxyPool.length} çalışan proxy.${C.reset}`);
  startAccounts(accounts);
}

function chooseProxyAndStart(selectedAccounts = null) {
  const accs = selectedAccounts || [];
  proxyVerifyLimit = loadProxyConfig().limit;

  if (!CONFIG.proxy.enabled) {
    startWithProxies(accs);
    return;
  }
  const remembered = loadProxyMode();
  proxyMode = remembered;

  console.log(`\n${C.green}${C.bold}── Proxy Dağıtımı ──────────────────────────────────${C.reset}`);
  console.log(`  ${C.bold}0${C.reset}. Proxysiz bağlan (direkt, proxy yok)`);
  console.log(`  ${C.bold}1${C.reset}. Tek proxy (tüm hesaplar aynı IP)`);
  console.log(`  ${C.bold}2${C.reset}. Her hesaba farklı proxy`);
  console.log(`  ${C.bold}3${C.reset}. Her 2 hesaba 1 proxy`);
  console.log(`  ${C.bold}4${C.reset}. Her 4 hesaba 1 proxy`);
  console.log(`${C.green}───────────────────────────────────────────────────────${C.reset}`);

  ensureReadline();

  rl.question(`${C.green}Mod seç (0-4, boş bırakılırsa "${modName(remembered)}" kullanılır): ${C.reset}`, (answer) => {
    const choice = parseInt(answer.trim(), 10);
    if (isNaN(choice) || choice < 0 || choice > 4) {
      proxyMode = remembered;
    } else {
      proxyMode = choice === 0 ? 'direct' : choice === 1 ? 'single' : choice === 2 ? 'per-account' : choice === 3 ? 'per-2' : 'per-4';
    }
    saveProxyMode(proxyMode);
    log('SYS', `Dağıtım modu: ${C.bold}${modName(proxyMode)}${C.reset}`);

    askCredentialsAndLimit(accs);
  });
}

// Girişten önce: otomatik giriş şifresi + doğrulama proxy sayısı sorulur
// (şifre zaten kayıtlıysa sadece limit sorulur → daha hızlı başlangıç)
function askCredentialsAndLimit(accs) {
  ensureReadline();

  const askLimit = () => {
    if (proxyMode === 'direct') {
      startWithProxies(accs); // doğrulama yok → limit sorusu atlanır
      return;
    }
    rl.question(`${C.green}Doğrulama için kaç proxy?${C.reset} ${C.dim}(50≈1dk / 150≈2.5dk / 300≈5dk — boş = kayıtlı ${proxyVerifyLimit})${C.reset}: `, (limAnswer) => {
      const lim = parseInt(limAnswer.trim(), 10);
      if (!isNaN(lim) && lim >= 10 && lim <= 1000) {
        proxyVerifyLimit = lim;
        saveProxyConfig(proxyMode, proxyVerifyLimit);
        log('SYS', `Doğrulama sınırı: ${C.bold}${proxyVerifyLimit} proxy${C.reset}`);
      } else if (limAnswer.trim() !== '') {
        log('WARN', 'Geçersiz sayı (10-1000), kayıtlı limit kullanılıyor.');
      }
      startWithProxies(accs);
    });
  };

  const withPw = accs.filter((acc) => getPasswordFor(acc));
  if (withPw.length === accs.length) {
    log('SYS', `Şifreler kayıtlı${C.dim} (${withPw.length}/${accs.length})${C.reset} — değiştirmek için: /setpass`);
    askLimit();
    return;
  }

  rl.question(`${C.green}Otomatik giriş şifresi${C.reset} ${C.dim}(boş = şifresiz; tek şifre tüm hesaplara uygulanır${C.reset}): `, (pwAnswer) => {
    const pw = pwAnswer.trim();
    if (pw) {
      accs.forEach((acc) => setPasswordFor(acc, pw));
      log('SYS', `${C.green}✔${C.reset} ${accs.length} hesaba şifre atandı${C.dim} (auth-passwords.json'a kaydedildi)${C.reset}`);
    } else {
      log('SYS', 'Şifre girilmedi, hesaplar şifresiz denenecek.');
    }
    askLimit();
  });
}
 
// ─── OTOMATİK GİRİŞ (AuthMe vb.) — hesap başına ───────────────────────────────

function authPasswordsPath() {
  return path.join(__dirname, 'auth-passwords.json');
}

function loadAuthPasswords() {
  try {
    const d = JSON.parse(fs.readFileSync(authPasswordsPath(), 'utf8'));
    return (d && d.passwords) || {};
  } catch (_) {
    return {};
  }
}

function saveAuthPasswords() {
  try {
    fs.writeFileSync(authPasswordsPath(), JSON.stringify(
      { passwords: authPasswords, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (_) {}
}

function getPasswordFor(account) {
  const uname = (account && account.username) || CONFIG.username;
  return authPasswords[uname] || CONFIG.authPassword || '';
}

function setPasswordFor(account, pw) {
  const uname = (account && account.username) || CONFIG.username;
  if (pw) {
    authPasswords[uname] = pw;
  } else {
    delete authPasswords[uname];
  }
  saveAuthPasswords();
}

function attemptAuthFor(entry, command, kind) {
  if (!entry) return;
  entry.authAttempts = (entry.authAttempts || 0) + 1;
  entry.lastAuthAttempt = Date.now();

  if (entry.authAttempts > MAX_AUTH_ATTEMPTS) {
    entry.authGiveUp = true;
    if (!authFailGroup.includes(entry.username)) authFailGroup.push(entry.username);
    log('ERROR', `${entry.username}: otomatik giriş ${MAX_AUTH_ATTEMPTS} kez denendi, başarısız. /toplu <şifre> ile toplu yeni şifre dene veya /setpass <hesap> <şifre>.`);
    return;
  }

  if (entry.bot && entry.bot.chat) {
    entry.bot.chat(command);
  }
  log('BOT', `${C.cyan}✔ ${entry.username}: otomatik ${kind} komutu gönderildi (deneme ${entry.authAttempts}/${MAX_AUTH_ATTEMPTS})${C.reset}`);
}

function tryAutoAuthFor(entry, text) {
  if (!entry) return;
  const password = getPasswordFor({ username: entry.username });
  if (!password) return;
  if (entry.isAuth || entry.authGiveUp) return;

  const now = Date.now();
  if (now - (entry.lastAuthAttempt || 0) < AUTH_COOLDOWN_MS) return;

  const registerPatterns = [/\/register/i, /kayıt ol/i, /henüz kayıtlı değil/i, /not registered/i];
  const loginPatterns    = [/\/login/i, /giriş yap/i, /lütfen giriş/i, /please login/i, /you (need|must) to ?login/i];
  const successPatterns  = [/giriş yaptın/i, /başarıyla giriş/i, /successfully logged in/i, /logged in successfully/i, /zaten giriş yap/i];

  if (successPatterns.some((p) => p.test(text))) {
    entry.isAuth = true;
    log('SYS', `${C.green}✔ ${entry.username}: otomatik giriş başarılı.${C.reset}`);
    return;
  }

  if (registerPatterns.some((p) => p.test(text))) {
    attemptAuthFor(entry, `/register ${password} ${password}`, 'register');
    return;
  }

  if (loginPatterns.some((p) => p.test(text))) {
    attemptAuthFor(entry, `/login ${password}`, 'login');
    return;
  }
}

// Giriş yapamayan GRUP için toplu şifre değişimi + anında yeniden deneme
function applyBulkPassword(pw) {
  const group = authFailGroup.slice();
  if (group.length === 0) {
    log('WARN', 'Şu an giriş yapamayan grup yok (authFailGroup boş).');
    return false;
  }
  group.forEach((uname) => setPasswordFor({ username: uname }, pw));
  authFailGroup = [];

  group.forEach((uname) => {
    const entry = bots.find((e) => e.username === uname && e.bot);
    if (!entry) return;
    entry.isAuth = false;
    entry.authGiveUp = false;
    entry.authAttempts = 0;
    entry.lastAuthAttempt = 0;
    if (entry.connected) {
      attemptAuthFor(entry, `/login ${pw}`, 'login');
    }
  });
  log('SYS', `${C.green}✔${C.reset} ${group.length} hesaba toplu şifre atandı: ${group.join(', ')}`);
  return true;
}

// ─── OTOMATİK CHAT DÖNGÜSÜ ────────────────────────────────────────────────────

function startAutoChat(intervalSeconds, message) {
  if (autoChatTimer) {
    clearInterval(autoChatTimer);
    autoChatTimer = null;
  }

  CONFIG.autoChat.enabled         = true;
  CONFIG.autoChat.intervalSeconds = intervalSeconds;
  CONFIG.autoChat.message         = message;

  log('BOT', `${C.green}✔ Otomatik mesaj döngüsü başlatıldı:${C.reset} her ${intervalSeconds} sn → "${message}"`);

  autoChatTimer = setInterval(() => {
    const connectedEntries = getConnectedBots();
    if (connectedEntries.length === 0) {
      log('WARN', `${C.dim}Bağlı bot yok, otomatik mesaj bu turda atlanıyor.${C.reset}`);
      return;
    }

    connectedEntries.forEach((entry) => {
      if (entry.bot && entry.bot.entity) {
        entry.bot.chat(CONFIG.autoChat.message);
      }
    });
    log('BOT', `${C.cyan}✔ Otomatik mesaj tüm bağlı hesaplara gönderildi:${C.reset} ${CONFIG.autoChat.message}`);
  }, intervalSeconds * 1000);
}

function stopAutoChat() {
  if (!autoChatTimer) {
    log('WARN', 'Otomatik mesaj döngüsü çalışmıyor!');
    return;
  }
  clearInterval(autoChatTimer);
  autoChatTimer = null;
  CONFIG.autoChat.enabled = false;
  log('BOT', `${C.red}✔ Otomatik mesaj döngüsü durduruldu${C.reset}`);
}

// ─── BOT OLUŞTUR ─────────────────────────────────────────────────────────────

function startAccounts(accounts) {
  if (!accounts || accounts.length === 0) {
    log('WARN', 'Başlatılacak hesap bulunamadı.');
    return;
  }

  selectedAccounts = accounts;

  // Proxy havuzu varsa hesaplara dağıt
  if (proxyPool.length > 0) {
    selectedAccounts = assignProxies(selectedAccounts, proxyPool, proxyMode);
    log('SYS', `${C.dim}Dağıtım: ${modName(proxyMode)} (${proxyPool.length} proxy / ${selectedAccounts.length} hesap)${C.reset}`);
  } else {
    selectedAccounts = selectedAccounts.map((acc) => ({ ...acc, proxy: null }));
  }

  selectedAccounts.forEach((account) => {
    account.failoversLeft = CONFIG.proxy.maxFailovers;
    createBot(account);
  });
}

function createBot(account = null) {
  const selectedAccount = account || { username: CONFIG.username };
  const username = selectedAccount.username || CONFIG.username;

  // Aynı hesabın eski bot kayıtlarını temizle (failover birikmesini önler)
  const oldEntries = bots.filter((entry) => entry.username === username);
  oldEntries.forEach((entry) => {
    try { if (entry.bot) entry.bot.removeAllListeners(); } catch (_) {}
    try { if (entry.bot) entry.bot.end(); } catch (_) {}
  });
  if (oldEntries.length > 0) {
    bots = bots.filter((entry) => entry.username !== username);
  }

  log('SYS', `${C.yellow}${CONFIG.host}:${CONFIG.port}${C.reset} adresine bağlanılıyor...`);
  log('SYS', `${C.dim}Oyuncu: ${username} | Offline mod${C.reset}`);

  const botOptions = {
    host:     CONFIG.host,
    port:     CONFIG.port,
    version:  CONFIG.version,
    username,
    auth:     CONFIG.auth,
  };

  // Hesaba özel proxy (account.proxy üzerinden, failover destekli)
  const accountProxy = selectedAccount.proxy || null;
  if (accountProxy) {
    let SocksClient;
    try {
      SocksClient = require('socks').SocksClient;
    } catch (err) {
      log('ERROR', `"socks" paketi bulunamadı. Kurmak için: ${C.bold}npm install socks${C.reset}`);
      return;
    }

    const failoversLeft = typeof selectedAccount.failoversLeft === 'number' ? selectedAccount.failoversLeft : CONFIG.proxy.maxFailovers;
    log('SYS', `${C.cyan}Proxy üzerinden bağlanılıyor: ${accountProxy.host}:${accountProxy.port} (SOCKS${accountProxy.type || 5})${C.reset}`);

    botOptions.connect = (client) => {
      SocksClient.createConnection({
        proxy: {
          host: accountProxy.host,
          port: accountProxy.port,
          type: accountProxy.type || 5,
        },
        command:     'connect',
        destination: { host: CONFIG.host, port: CONFIG.port },
        timeout:     CONFIG.proxy.verifyTimeout,
      }).then((info) => {
        client.setSocket(info.socket);
        client.emit('connect');
      }).catch((err) => {
        log('ERROR', `Proxy bağlantı hatası (${username}): ${err.message}`);
        if (CONFIG.proxy.enabled && proxyPool.length > 0) {
          // Otomatik geçiş: kara liste → sonraki proxy → hızlıca yeniden bağlan
          handleProxyFailover(selectedAccount, failoversLeft, err);
        } else {
          client.emit('error', err);
        }
      });
    };
  }

  try {
    const currentBot = mineflayer.createBot(botOptions);
    const entry = {
      account: selectedAccount,
      proxy:   accountProxy,
      bot: currentBot,
      connected: false,
      failoverHandled: false,
      username,
      isMining: false,
      miningTimer: null,
      isAfk: false,
      afkTimer: null,
      isAuth: false,
      authGiveUp: false,
      authAttempts: 0,
      lastAuthAttempt: 0,
    };
    bots.push(entry);
    bot = currentBot;

    currentBot.on('login', () => {
      entry.connected = true;
      isConnected = true;
      const viaProxy = entry.proxy ? ` | ${C.cyan}IP: ${entry.proxy.host}:${entry.proxy.port}${C.reset}` : '';
      log('SYS', `${C.green}✔ Bağlantı kuruldu!${C.reset} Oyuncu: ${C.bold}${currentBot.username}${C.reset}${viaProxy}`);

      entry.isAuth = false;
      entry.authGiveUp = false;
      entry.authAttempts = 0;
      entry.lastAuthAttempt = 0;

      startConsole();

      if (CONFIG.autoChat.enabled && !autoChatTimer) {
        startAutoChat(CONFIG.autoChat.intervalSeconds, CONFIG.autoChat.message);
      }
    });

    currentBot.on('chat', (sender, message) => {
      if (sender === currentBot.username) return;
      const entryText = `${C.yellow}${sender}${C.reset}: ${message}`;
      chatHistory.push({ username: sender, message, time: timestamp() });
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      log('CHAT', entryText);
      tryAutoAuthFor(entry, message);
    });

    currentBot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      if (!text.includes(':')) {
        log('INFO', `${C.dim}${text}${C.reset}`);
      }
      tryAutoAuthFor(entry, text);
    });

    currentBot.on('kicked', (reason) => {
      entry.connected = false;
      isConnected = isAnyBotConnected();
      log('WARN', `Sunucudan atıldı: ${C.red}${reason}${C.reset}`);
    });

    currentBot.on('error', (err) => {
      entry.connected = false;
      isConnected = isAnyBotConnected();
      if (CONFIG.proxy.enabled && selectedAccount.proxy && typeof selectedAccount.failoversLeft === 'number' && selectedAccount.failoversLeft > 0 && !entry.failoverHandled && proxyPool.length > 0) {
        entry.failoverHandled = true;
        handleProxyFailover(selectedAccount, selectedAccount.failoversLeft, err);
      } else {
        log('ERROR', err.message);
      }
    });

    currentBot.on('end', () => {
      entry.connected = false;
      isConnected = isAnyBotConnected();
      if (CONFIG.proxy.enabled && selectedAccount.proxy && typeof selectedAccount.failoversLeft === 'number' && selectedAccount.failoversLeft > 0 && !entry.failoverHandled && proxyPool.length > 0) {
        entry.failoverHandled = true;
        handleProxyFailover(selectedAccount, selectedAccount.failoversLeft, new Error('bağlantı kesildi'));
      } else {
        log('WARN', 'Bağlantı kesildi.');
      }
    });
  } catch (err) {
    log('ERROR', `Bot oluşturulamadı: ${err.message}`);
  }
}

// ─── MADENCİLİK ──────────────────────────────────────────────────────────────

function startMining() {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }

  if (isMining) {
    log('WARN', 'Zaten madencilik yapılıyor!');
    return;
  }

  isMining = true;
  log('BOT', `${C.green}✔ Madencilik tüm bağlı hesaplara başlatıldı (Aralıksız Mod)${C.reset}`);

  connectedEntries.forEach((entry) => {
    if (!entry.bot || !entry.bot.entity) return;
    entry.isMining = true;

    const mineLoop = async () => {
      if (!entry.isMining || !entry.bot || !entry.bot.entity) return;

      try {
        const block = entry.bot.blockAtCursor(6);

        if (!block || block.name === 'air' || block.name === 'bedrock') {
          entry.miningTimer = setTimeout(mineLoop, 50);
          return;
        } else {
          await entry.bot.dig(block);
          if (entry.isMining) setImmediate(mineLoop);
          return;
        }
      } catch (err) {
        entry.miningTimer = setTimeout(mineLoop, 500);
        return;
      }
    };

    entry.miningTimer = setTimeout(mineLoop, 50);
  });
}

function stopMining() {
  if (!isMining && !getConnectedBots().some((entry) => entry.isMining)) {
    log('WARN', 'Madencilik yapılmıyor!');
    return;
  }

  isMining = false;
  getConnectedBots().forEach((entry) => {
    entry.isMining = false;
    if (entry.miningTimer) {
      clearTimeout(entry.miningTimer);
      entry.miningTimer = null;
    }
    try { entry.bot.stopDigging(); } catch (e) {}
  });

  log('BOT', `${C.red}✔ Madencilik tüm bağlı hesaplarda durduruldu${C.reset}`);
}

// ─── HAREKET KOMUTLARI ───────────────────────────────────────────────────────

function moveForward(blocks = 2) {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }

  log('INFO', `${C.green}↗ ${blocks} blok ileri gidiliyor tüm hesaplara...${C.reset}`);
  connectedEntries.forEach((entry) => {
    entry.bot.setControlState('forward', true);
    setTimeout(() => {
      entry.bot.setControlState('forward', false);
    }, blocks * 400);
  });
}

function moveBackward(blocks = 2) {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }

  log('INFO', `${C.yellow}↙ ${blocks} blok geri gidiliyor tüm hesaplara...${C.reset}`);
  connectedEntries.forEach((entry) => {
    entry.bot.setControlState('back', true);
    setTimeout(() => {
      entry.bot.setControlState('back', false);
    }, blocks * 400);
  });
}

function moveRight(blocks = 2) {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }

  log('INFO', `${C.cyan}→ ${blocks} blok sağa gidiliyor tüm hesaplara...${C.reset}`);
  connectedEntries.forEach((entry) => {
    entry.bot.setControlState('right', true);
    setTimeout(() => {
      entry.bot.setControlState('right', false);
    }, blocks * 400);
  });
}

function moveLeft(blocks = 2) {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }

  log('INFO', `${C.cyan}← ${blocks} blok sola gidiliyor tüm hesaplara...${C.reset}`);
  connectedEntries.forEach((entry) => {
    entry.bot.setControlState('left', true);
    setTimeout(() => {
      entry.bot.setControlState('left', false);
    }, blocks * 400);
  });
}

// ─── HOTBAR DROP ─────────────────────────────────────────────────────────────

function dropHotbarSlot(slotNum) {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > 9) {
    log('WARN', 'Slot numarası 1-9 arasında olmalı! Örnek: /drop slot 3');
    return;
  }

  connectedEntries.forEach((entry) => {
    const windowSlot = 35 + slotNum;
    const item = entry.bot.inventory.slots[windowSlot];

    if (!item) {
      log('WARN', `${entry.username} için slot ${slotNum} boş, atlanıyor.`);
      return;
    }

    entry.bot.tossStack(item)
      .then(() => {
        log('BOT', `${C.green}✔ ${entry.username} için slot ${slotNum} → ${item.displayName || item.name} (x${item.count}) droplandı${C.reset}`);
      })
      .catch((err) => {
        log('ERROR', `${entry.username} için slot ${slotNum} droplanamadı: ${err.message}`);
      });
  });
}

async function dropAllHotbarSlots() {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }

  log('BOT', `${C.yellow}✔ İlk 9 slottaki itemler tüm hesaplara droplanıyor...${C.reset}`);

  for (const entry of connectedEntries) {
    for (let slotNum = 1; slotNum <= 9; slotNum++) {
      const windowSlot = 35 + slotNum;
      const item = entry.bot.inventory.slots[windowSlot];

      if (item) {
        try {
          await entry.bot.tossStack(item);
          log('BOT', `${C.green}✔ ${entry.username} için slot ${slotNum} → ${item.displayName || item.name} (x${item.count}) droplandı${C.reset}`);
        } catch (err) {
          log('ERROR', `${entry.username} için slot ${slotNum} droplanamadı: ${err.message}`);
        }
      }

      await new Promise((res) => setTimeout(res, 250));
    }
  }

  log('BOT', `${C.green}✔ Hotbar droplama tamamlandı${C.reset}`);
}

// ─── AFK MOD ──────────────────────────────────────────────────────────────────

function startAfk() {
  const connectedEntries = getConnectedBots();
  if (connectedEntries.length === 0) {
    log('WARN', 'Bağlı bot yok!');
    return;
  }
  if (isAfk) {
    stopAfk();
    return;
  }

  isAfk = true;
  log('BOT', `${C.green}✔ AFK modu tüm bağlı hesaplara başlatıldı${C.reset} (İlk hareket 1dk sonra)`);

  connectedEntries.forEach((entry) => {
    entry.isAfk = true;

    const afkLoop = () => {
      if (!entry.isAfk || !entry.bot || !entry.bot.entity) return;

      try {
        entry.bot.setControlState('back', true);
        setTimeout(() => {
          entry.bot.setControlState('back', false);
          setTimeout(() => {
            entry.bot.setControlState('forward', true);
            setTimeout(() => {
              entry.bot.setControlState('forward', false);
              if (entry.isAfk) {
                entry.afkTimer = setTimeout(afkLoop, 60000);
              }
            }, 1500);
          }, 2000);
        }, 1500);
      } catch (err) {
        log('ERROR', `${entry.username} AFK hatası: ${err.message}`);
      }
    };

    entry.afkTimer = setTimeout(afkLoop, 60000);
  });
}

function stopAfk() {
  if (!isAfk && !getConnectedBots().some((entry) => entry.isAfk)) {
    log('WARN', 'AFK modu açık değil!');
    return;
  }

  isAfk = false;
  getConnectedBots().forEach((entry) => {
    entry.isAfk = false;
    if (entry.afkTimer) {
      clearTimeout(entry.afkTimer);
      entry.afkTimer = null;
    }
    try { entry.bot.setControlState('forward', false); } catch (_) {}
    try { entry.bot.setControlState('back', false); } catch (_) {}
  });

  log('BOT', `${C.green}✔ AFK modu tüm bağlı hesaplarda durduruldu${C.reset}`);
}

// ─── KONSOL ARAYÜZÜ ──────────────────────────────────────────────────────────

function startConsole() {
  if (consoleStarted) return;
  consoleStarted = true;

  ensureReadline();
  rl.setPrompt(`${C.green}> ${C.reset}`);
  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/msg ')) {
      const msg = input.slice(5);
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) { log('WARN', 'Bağlı hesap yok!'); }
      else {
        connectedEntries.forEach((entry) => entry.bot.chat(msg));
        log('BOT', `${C.bold}Sen${C.reset}: ${msg} (${connectedEntries.length} hesap)`);
      }

    } else if (input.startsWith('/cmd ')) {
      const cmd = input.slice(5);
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) { log('WARN', 'Bağlı hesap yok!'); }
      else {
        connectedEntries.forEach((entry) => entry.bot.chat(`/${cmd}`));
        log('BOT', `Komut: /${cmd} (${connectedEntries.length} hesap)`);
      }

    } else if (input === '/info') {
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) {
        log('WARN', 'Bağlı bot yok.');
      } else {
        const primary = connectedEntries[0];
        const ent = primary.bot.entity;
        const pos = ent ? ent.position : null;
        console.log(`
${C.cyan}── Bot Bilgileri ──────────────────────────${C.reset}
  Hesap sayısı  : ${connectedEntries.length}
  Ana kullanıcı : ${C.bold}${primary.bot.username}${C.reset}
  Sunucu        : ${CONFIG.host}:${CONFIG.port}
  Konum         : ${pos ? `x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)}` : 'bekleniyor (spawn alınmadı)'}
  Can           : ${primary.bot.health?.toFixed(1) ?? '?'}/20
  Açlık         : ${primary.bot.food ?? '?'}/20
  Ping          : ${primary.bot.player?.ping ?? '?'} ms
  Madencilik    : ${isMining ? '✓ AÇik' : '✗ KAPALI'}
  AFK           : ${isAfk ? '✓ AÇik' : '✗ KAPALI'}
  Proxy Modu    : ${CONFIG.proxy.enabled ? modName(proxyMode) + ` (${proxyPool.length} proxy, limit ${proxyVerifyLimit})` : '✗ Kullanılmıyor'}
  Otomatik Giriş: ${!getPasswordFor(primary.account) ? '✗ Şifre yok' : primary.isAuth ? '✓ Giriş yapıldı' : primary.authGiveUp ? '✗ Başarısız (toplu: /toplu <şifre>)' : '… Bekleniyor'}
  Otomatik Chat : ${CONFIG.autoChat.enabled && autoChatTimer ? `✓ ${CONFIG.autoChat.intervalSeconds} sn aralıkla` : '✗ KAPALI'}
${C.cyan}───────────────────────────────────────────${C.reset}`);
      }

    } else if (input === '/proxies') {
      const allEntries = bots.filter((entry) => entry && entry.bot);
      if (selectedAccounts.length === 0) {
        log('WARN', 'Hesap ataması yapılmadı.');
      } else {
        console.log(`\n${C.cyan}── Proxy / IP Haritası ${C.dim}(${proxyPool.length} havuz, ${proxyBlacklist.size} kara liste)${C.reset}`);
        selectedAccounts.forEach((acc) => {
          const entry = allEntries.find((e) => e.account === acc || e.username === acc.username);
          const state = entry && entry.connected
            ? `${C.green}✓${C.reset}`
            : entry ? `${C.yellow}…${C.reset}` : `${C.gray}-${C.reset}`;
          const ip = acc.proxy ? `${acc.proxy.host}:${acc.proxy.port}` : `${C.dim}direkt${C.reset}`;
          console.log(`  ${state} ${C.bold}${acc.username}${C.reset} → ${ip}`);
        });
        console.log(`${C.cyan}───────────────────────────────────────────${C.reset}\n`);
      }

    } else if (input === '/history') {
      const last = chatHistory.slice(-20);
      if (last.length === 0) {
        log('INFO', 'Henüz chat mesajı yok.');
      } else {
        console.log(`\n${C.cyan}── Son ${last.length} Mesaj ───────────────────────${C.reset}`);
        last.forEach(e => {
          console.log(`  ${C.gray}[${e.time}]${C.reset} ${C.yellow}${e.username}${C.reset}: ${e.message}`);
        });
        console.log(`${C.cyan}───────────────────────────────────────────${C.reset}\n`);
      }

    } else if (input === '/mine') {
      startMining();

    } else if (input === '/stop') {
      stopMining();

    } else if (input === '/afk') {
      startAfk();

    } else if (input === '/afk stop' || input === '/afk-stop') {
      stopAfk();

    } else if (input === '/ileri') {
      moveForward(2);

    } else if (input === '/geri') {
      moveBackward(2);

    } else if (input === '/sag') {
      moveRight(2);

    } else if (input === '/sol') {
      moveLeft(2);

    } else if (/^\/drop\s+slot\s+\d+$/.test(input)) {
      const slotNum = parseInt(input.match(/\d+$/)[0], 10);
      dropHotbarSlot(slotNum);

    } else if (input === '/drop all') {
      dropAllHotbarSlots();

    } else if (input.startsWith('/setpass ')) {
      const rest = input.slice('/setpass '.length).trim();
      const parts = rest.split(/\s+/);
      // Tek parametre → tüm seçili hesaplara; iki+ → <hesap> <şifre> veya all <şifre>
      if (parts.length === 1) {
        const pw = rest;
        selectedAccounts.forEach((acc) => setPasswordFor(acc, pw));
        forEachConnectedBot((entry) => {
          if (selectedAccounts.some((acc) => acc.username === entry.username)) {
            entry.isAuth = false;
            entry.authGiveUp = false;
            entry.authAttempts = 0;
            entry.lastAuthAttempt = 0;
            if (entry.connected) attemptAuthFor(entry, `/login ${pw}`, 'login');
          }
        });
        log('SYS', `${C.green}✔${C.reset} Seçili ${selectedAccounts.length} hesaba şifre atandı ve giriş yeniden denenecek.`);
      } else {
        const target = parts[0];
        const pw = rest.slice(target.length).trim();
        if (target.toLowerCase() === 'all') {
          loadAccounts().forEach((acc) => setPasswordFor(acc, pw));
          log('SYS', `${C.green}✔${C.reset} Tüm hesaplara (hesaplar.json) şifre atandı.`);
        } else {
          setPasswordFor({ username: target }, pw);
          const entry = bots.find((e) => e.username === target && e.bot);
          if (entry) {
            entry.isAuth = false;
            entry.authGiveUp = false;
            entry.authAttempts = 0;
            entry.lastAuthAttempt = 0;
            if (entry.connected) attemptAuthFor(entry, `/login ${pw}`, 'login');
          }
          log('SYS', `${C.green}✔${C.reset} ${target} hesabına şifre atandı.`);
        }
      }

    } else if (input === '/pass') {
      const names = selectedAccounts.length > 0
        ? selectedAccounts.map((acc) => acc.username)
        : loadAccounts().map((acc) => acc.username);
      console.log(`\n${C.cyan}── Şifre Eşlemesi ──────────────────────────────${C.reset}`);
      names.forEach((uname) => {
        const pw = authPasswords[uname];
        const entry = bots.find((e) => e.username === uname && e.bot);
        const state = entry ? (entry.isAuth ? `${C.green}✓ giriş yaptı${C.reset}` : entry.authGiveUp ? `${C.red}şifre hatalı${C.reset}` : `${C.yellow}bekliyor${C.reset}`) : `${C.gray}kapalı${C.reset}`;
        console.log(`  ${C.bold}${uname}${C.reset} → ${pw ? `${C.dim}'${pw}'${C.reset}` : C.gray + '(şifre yok)' + C.reset}  ${state}`);
      });
      console.log(`${C.cyan}───────────────────────────────────────────────${C.reset}`);
      log('INFO', 'Değiştirmek için: /setpass <şifre> (tüm seçili) | /setpass <hesap> <şifre> | /setpass all <şifre> | Toplu: /toplu <şifre>');

    } else if (input.startsWith('/toplu ')) {
      const pw = input.slice('/toplu '.length).trim();
      if (!pw) {
        log('WARN', 'Kullanım: /toplu <şifre>');
      } else {
        applyBulkPassword(pw);
      }

    } else if (input.startsWith('/proxycount ')) {
      const n = parseInt(input.slice('/proxycount '.length).trim(), 10);
      if (isNaN(n) || n < 10 || n > 1000) {
        log('WARN', 'Kullanım: /proxycount <10-1000>');
      } else {
        proxyVerifyLimit = n;
        saveProxyConfig(proxyMode, proxyVerifyLimit);
        log('SYS', `${C.green}✔${C.reset} Doğrulama limiti ${n} proxy olarak güncellendi (bir sonraki çekimde uygulanır).`);
      }

    } else if (input === '/autochat stop') {
      stopAutoChat();

    } else if (input.startsWith('/autochat ')) {
      const argsStr = input.slice('/autochat '.length).trim();
      const match = argsStr.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        log('WARN', 'Kullanım: /autochat <saniye> <mesaj>   veya   /autochat stop');
      } else {
        const seconds = parseInt(match[1], 10);
        const message = match[2];
        startAutoChat(seconds, message);
      }

    } else if (input === '/autochat') {
      if (CONFIG.autoChat.enabled && autoChatTimer) {
        log('INFO', `Otomatik mesaj AÇIK → her ${CONFIG.autoChat.intervalSeconds} sn: "${CONFIG.autoChat.message}"`);
      } else {
        log('INFO', 'Otomatik mesaj KAPALI. Kullanım: /autochat <saniye> <mesaj>');
      }

    } else if (input === '/hesap') {
      log('SYS', 'Hesap değiştirilecek, tüm botlar kapatılıyor...');
      stopMining();
      stopAfk();
      disconnectAllBots();
      isConnected = false;
      consoleStarted = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      setTimeout(() => {
        chooseAccountAndStart();
      }, 1000);

    } else if (input === '/reconnect') {
      log('SYS', 'Yeniden bağlanılıyor...');
      isConnected = false;
      stopMining();
      stopAfk();
      disconnectAllBots();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      startAccounts(selectedAccounts.length > 0 ? selectedAccounts : loadAccounts());

    } else if (input === '/quit' || input === '/exit') {
      log('SYS', 'Tüm botlar kapatılıyor...');
      stopMining();
      stopAfk();
      disconnectAllBots();
      process.exit(0);

    } else {
      log('WARN', `Bilinmeyen komut: ${input}`);
      log('INFO', '/msg /cmd /mine /stop /afk /ileri /geri /sag /sol /drop slot N /drop all /setpass /toplu /pass /proxycount /autochat /info /proxies /history /hesap /reconnect /quit');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    log('SYS', 'Konsol kapatıldı.');
    process.exit(0);
  });
}

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

authPasswords = loadAuthPasswords();
banner();
const proxyOnlyArgs = parseProxyOnlyArgs(process.argv.slice(2));
if (proxyOnlyArgs) {
  runProxyOnly(proxyOnlyArgs.target, proxyOnlyArgs.maxLatency).catch((err) => {
    log('ERROR', 'Proxy toplama hatası: ' + err.message);
    process.exit(1);
  });
} else {
  chooseAccountAndStart();
}
