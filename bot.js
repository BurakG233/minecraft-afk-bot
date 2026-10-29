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
 *   DOSYA: auth-passwords.json (okuma/yazma — AuthMe şifreleri)
 *   DOSYA: replay-scripts.json (okuma/yazma — atılınca tekrar oynatılacak komutlar)
 *   DOSYA: ayarlar.json   (okuma/yazma — komut aralığı / bağlantı aralığı ayarları)
 * ORTAM DEĞİŞKENİ (test için — kopya dosya gerekmez):
 *   BOT_HOST=127.0.0.1              → yerel test sunucusu
 *   BOT_HOST=mc.atlasoyuncu.com     → canlı sunucu
 *   BOT_PORT=25565                  → port
 *   BOT_VERSION=1.21.11             → sürüm geçersiz kılma
 *   BOT_MAX=1                       → bu sayıdan fazla hesap seçilirse bot DURUR
 *                                   (canlıya istemeden 100 bot gönderilmesini önler)
 * KULLANIM: node bot.js  (etkileşimli) | node bot.js --proxy-only [adet] [--max-ping=ms]
 * BAĞIMLI: mineflayer, minecraft-protocol, minecraft-data, socks, vec3,
 *          proxy-lib.js (node içi https/fs/path/readline)
 * ═══════════════════════════════════════════════════════════
 */

const mineflayer = require('mineflayer');
const mcProtocol = require('minecraft-protocol');
const mcData     = require('minecraft-data');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');
const proxyLib   = require('./proxy-lib.js');

// ─── AYARLAR ─────────────────────────────────────────────────────────────────
const CONFIG = {
  host:           'mc.atlasoyuncu.com',
  port:           25565,
  version:        '1.20.1', // sunucu 1.21.8+ sürümlerinde AuthMe GÖRSEL giriş ekranı
                          // (show_dialog) açıyor ve yanıtlanmadığı için bağlantı
                          // configuration aşamasında kilitleniyordu. 1.20.1'de
                          // configuration aşaması yok, klasik "/login <şifre>"
                          // komutu çalışıyor ve bağlantı testte sağlam kaldı.
  // version 'auto' yapılırsa sunucunun sürümü ping ile algılanır (dikkat:
  // 1.21.8+ algılanırsa yukarıdaki görsel giriş ekranı sorunu geri gelir)
  versionFallbacks: ['1.21.1', '1.21.7', '1.19.4'], // 1.20.1 çalışmazsa sırayla denenir
  fallbackVersion: '1.20.1', // 'auto' modda ping başarısız olursa
  username:       'BurakG2', // Dinamik olarak hesaplar.json'dan gelecek
  auth:           'offline',
  reconnect:      true,
  reconnectDelay: 10,      // yeniden bağlanma ilk gecikmesi (sn)
  reconnectMaxDelay: 120,  // üstel geri çekilme tavanı (sn)
  connectStaggerMs: 500,   // hesaplar arası bağlanma aralığı (ms): sunucuyu ve işletim
                         // sistemi soket havuzunu boğmamak için (350 ms'de 100
                         // hesapta çok sayıda ECONNRESET oluyordu)
  connectJitterMs: 150,    // bağlanma aralığına eklenen rastgele gecikme (0..N ms):
                         // 100 bot tam 0,500,1000 ms deseninde bağlanmasın
  checkTimeout:   60000,   // sunucu cevap vermezse hata (ms)
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

  // Yeniden bağlanınca tekrarlanacak komut dizisi ("eski haline dönme")
  replay: {
    enabled:       true,  // atılınca/bağlantı kopunca komutları tekrar gönder
    recordChat:    false,  // /msg ile gönderilen sohbetleri de kaydet (varsayılan HAYIR)
    delayMs:       1200,   // kaydedilen komutlar arası bekleme
    startDelayMs:  2500,   // giriş tamamlandıktan kaç ms sonra ilk komut gönderilecek
    authWaitMs:    9000,   // AuthMe giriş onayı için en fazla beklenecek süre
    authPollMs:    250,    // giriş durumu kontrol aralığı
    maxSteps:      30,     // hesap başına saklanacak en fazla adım
    file:          'replay-scripts.json',
  },

  // Aynı mesajın hem CHAT hem INFO olarak iki kez basılmasını engelle
  chat: {
    dedupeWindowMs: 2000,   // bu pencere içinde aynı metin tekrar basılmaz
    dedupeKeep:    8,      // hesap başına saklanacak son mesaj sayısı
  },

  // ─── GİDEN KOMUT ARALIĞI (FLOOD / SALDIRI ALGISI KORUMASI) ────────────────
  // 100+ bot aynı anda bağlıyken /login, /cmd, /msg gibi komutlar aynı
  // milisaniyede gidiyordu. Sunucu (AuthMe + anti-bot eklentileri) bunu
  // saldırı sayıp bağlantı atabiliyor. Artık TÜM giden komutlar tek kuyruktan
  // geçer ve aralarına en az spacingMs kadar boşluk konur.
  action: {
    spacingMs: 50,      // iki giden komut arası en az bekleme (ms)
    jitterMs:  25,      // üstüne eklenen RASTGELE gecikme (0..jitterMs):
                        // sabit 50 ms'lik kusursuz desen de bot gibi görünmesin
    expireMs:  20000,   // kuyrukta bu süreden fazla bekleyen komut gönderilmez
    maxQueue:  2000,    // kuyruk tavanı (aşılırsa en eski komut düşer)
  },
};

// ─── ORTAM DEĞİKENİ TEST KONTROLÜ ─────────────────────────────────────────────
// NEDEN: Daha önce test için bot.js'in kopyaları (_localtest.js / _livetest.js)
// klasöre bırakılıyordu ve hangisinin canlı sunucuya gittiği karışıyordu.
// Artık kopya gerekmiyor; testler ortam değişkeniyle yapılıyor:
//
//   BOT_HOST=127.0.0.1          → yerel test sunucusu
//   BOT_HOST=mc.atlasoyuncu.com → canlı sunucu
//   BOT_PORT=25565              → port (opsiyonel)
//   BOT_VERSION=1.21.11         → sürüm geçersiz kılma (yerel sunucu 1.21.11)
//   BOT_MAX=1                   → BU sayıdan fazla hesap seçilirse bot DURUR
//
// BOT_MAX güvenlik kilididir: canlı sunucuya istemeden 100 hesap
// gönderilmesini kesin olarak engeller (aşılırsa hiç bağlanılmaz).
const ENV_OVERRIDES = [];
function envOverride(key, apply) {
  const val = process.env[key];
  if (val === undefined || val === '') return;
  apply(val);
  ENV_OVERRIDES.push(`${key}=${val}`);
}
envOverride('BOT_HOST',    (v) => { CONFIG.host = v; });
envOverride('BOT_PORT',    (v) => { CONFIG.port = parseInt(v, 10) || CONFIG.port; });
envOverride('BOT_VERSION', (v) => { CONFIG.version = v; });
const BOT_MAX_ACCOUNTS = (() => {
  const n = parseInt(process.env.BOT_MAX || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
if (BOT_MAX_ACCOUNTS > 0) ENV_OVERRIDES.push(`BOT_MAX=${BOT_MAX_ACCOUNTS}`);

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
let serverVersion    = null; // ping ile çözülen gerçek MC sürümü (null = henüz bilinmiyor)
let intentionalStop  = false; // true iken otomatik yeniden bağlanma yapılmaz
let pendingQuestion  = false; // true iken konsol komutları yorumlanmaz

// ─── TEKRAR EDEN MESAJ FİLTRESİ ─────────────────────────────────────────────
// SORUN: mineflayer aynı oyuncu mesajını hem 'chat' hem 'message' olayıyla
// yayıyordu → aynı satır hem [CHAT] hem [INFO] olarak 2 kez basılıyordu.
// (Sunucu 26.x'e geçince imzali sohbet paketlerinde toString() "gönderen: "
// önekini içermediği için bu çok sık tetikleniyor.)
// ÇÖZÜM: hesap başına son basılan metinleri kısa bir zaman penceresiyle
// hatırlıyoruz; aynı metin pencere içinde tekrar gelirse basılmıyor.
const lastLogged = new Map(); // username → [{ text, at }]  (son N mesaj)

// ─── KOMUT KAYDI (replay) ───────────────────────────────────────────────────
// Atılınca/bağlantı kopunca "eski haline dönme": kullanıcının gönderdiği
// komutlar (örn. /login 1234, /skyblock) hesap başına kaydedilir, bağlantı
// kurulunca aynı sırayla tekrar gönderilir.
let replayScripts = {};   // username → [{ kind: 'cmd'|'chat', text, delayMs }]
const replayTimers = new Map(); // username → [setTimeout id] (iptal için)

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
let consoleBound   = false;

// ─── SÜREÇ GÜVENLİK AĞI ─────────────────────────────────────────────────────
// 100 hesap aynı anda çalışırken tek bir botun soket hatası tüm süreci
// düşürüyordu. Burada yakalanan hata loglanır, süreç yaşamaya devam eder.
process.on('uncaughtException', (err) => {
  log('ERROR', `Yakalanmamış hata: ${err && err.message ? err.message : err}`);
});
process.on('unhandledRejection', (err) => {
  const msg = err && err.message ? err.message : err;
  log('ERROR', `İşlenmemiş promise hatası: ${msg}`);
});

// ─── KOMUT KAYDI / REPLAY ───────────────────────────────────────────────────
// Sunucudan atılınca veya bağlantı kopunca "eski haline dönme".
// Kullanıcının gönderdiği komutlar hesap başına sırayla saklanır
// (örn: /login 1234, /skyblock) ve bağlantı yeniden kurulunca tekrar
// gönderilir.
function replayFilePath() {
  return path.join(__dirname, CONFIG.replay.file);
}

function loadReplayScripts() {
  try {
    if (fs.existsSync(replayFilePath())) {
      const data = JSON.parse(fs.readFileSync(replayFilePath(), 'utf8'));
      if (data && typeof data === 'object') {
        replayScripts = data;
        log('SYS', `${C.dim}Kayıtlı komut dizisi yüklendi: ${Object.keys(replayScripts).length} hesap${C.reset}`);
      }
    }
  } catch (err) {
    log('WARN', `Komut kaydı okunamadı: ${err.message}`);
  }
}

function saveReplayScripts() {
  try {
    // Atomik yazım: önce geçici dosya, sonra taşı (yarım kalmış JSON oluşmaz)
    const target = replayFilePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(replayScripts, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('WARN', `Komut kaydı yazılamadı: ${err.message}`);
  }
}

// Bir komutu / mesajı hesabın dizisine ekle
function recordStep(username, kind, text) {
  if (!CONFIG.replay.enabled || !username || !text) return;
  if (kind === 'chat' && !CONFIG.replay.recordChat) return;

  if (!Array.isArray(replayScripts[username])) replayScripts[username] = [];

  // Aynı komutu üst üste basma (spam koruması)
  const last = replayScripts[username][replayScripts[username].length - 1];
  if (last && last.kind === kind && last.text === text) return;

  replayScripts[username].push({ kind, text, delayMs: CONFIG.replay.delayMs });
  while (replayScripts[username].length > CONFIG.replay.maxSteps) {
    replayScripts[username].shift();
  }
  saveReplayScripts();
}

// Bağlantı kurulunca kayıtlı komutları sırayla tekrar gönder
function startReplayFor(entry, botInstance) {
  const username = entry.username;

  // Bu hesap için önceki bir tekrar kuyruğu hâlâ çalışıyorsa iptal et.
  // (Aksi halde hem eski hem yeni bağlantının komutları gönderilirdi.)
  cancelReplayFor(username);

  const steps = replayScripts[username];
  if (!CONFIG.replay.enabled || !Array.isArray(steps) || steps.length === 0) return;

  log('SYS', `${C.cyan}⟳ Kayıtlı komutlar tekrar oynatılıyor${C.reset} (${username}, ${steps.length} adım): ${C.dim}${steps.map((s) => s.text).join(' → ')}${C.reset}`);

  const timers = [];
  replayTimers.set(username, timers);

  let total = CONFIG.replay.startDelayMs;
  const plan = steps.map((step) => {
    const item = { ...step, at: total };
    total += Math.max(200, Number(step.delayMs) || CONFIG.replay.delayMs);
    return item;
  });

  plan.forEach((step) => {
    const id = setTimeout(() => {
      if (!entry.connected || entry.bot !== botInstance) return; // arada çıktıysa iptal
      try {
        if (step.kind === 'cmd') queueChat(botInstance, step.text.startsWith('/') ? step.text : `/${step.text}`, username);
        else queueChat(botInstance, step.text, username);
        log('BOT', `${C.dim}⟳ tekrar: ${step.text}${C.reset}`);
      } catch (err) {
        log('WARN', `Komut tekrarı gönderilemedi (${step.text}): ${err.message}`);
      }
    }, step.at);
    timers.push(id);
  });
}

function cancelReplayFor(username) {
  const timers = replayTimers.get(username);
  if (!timers) return;
  timers.forEach((id) => clearTimeout(id)); // Node'da clearTimeout interval'ı da siler
  replayTimers.delete(username);
}

// Kayıtlı komutları göndermeden ÖNCE AuthMe girişinin bitmesini bekle.
// SORUN: Replay, bağlantı kurulur kurulmaz başlıyordu. AuthMe girişi 2 sn
// sürdüğü için "/skyblock" gibi komutlar giriş öncesi gidiyor ve sunucu
// onları sessizce reddediyordu.
// ÇÖZÜM: Giriş onayı (entry.isAuth) gelene kadar bekle. Şifresiz hesaplarda
// bekleme yok. Onay hiç gelmezse authWaitMs sonunda yine de gönder — yoksa
// giriş mesajı yanlış okunduğunda komutlar hiç çalışmaz.
function scheduleReplayAfterAuth(entry, botInstance) {
  const username = entry.username;
  cancelReplayFor(username); // önceki kuyruk + önceki bekleme iptal

  const steps = replayScripts[username];
  if (!CONFIG.replay.enabled || !Array.isArray(steps) || steps.length === 0) return;

  const hasPassword = !!getPasswordFor({ username: username });
  if (!hasPassword) { startReplayFor(entry, botInstance); return; }

  log('SYS', `${C.dim}⏳ ${username}: giriş onayı bekleniyor, sonra ${steps.length} komut oynatılacak…${C.reset}`);

  const t0 = Date.now();
  const handle = setInterval(() => {
    // Arada bağlantı kopmuşsa vazgeç
    if (!entry.connected || entry.bot !== botInstance) { clearInterval(handle); return; }

    const ok = entry.isAuth;
    const timedOut = (Date.now() - t0) >= CONFIG.replay.authWaitMs;
    if (!ok && !timedOut) return;

    clearInterval(handle);
    if (!ok) {
      log('WARN', `${username}: ${CONFIG.replay.authWaitMs / 1000} sn içinde giriş onayı gelmedi; komutlar yine de gönderiliyor.`);
    }
    startReplayFor(entry, botInstance);
  }, CONFIG.replay.authPollMs);

  const list = replayTimers.get(username) || [];
  list.push(handle);
  replayTimers.set(username, list);
}

function cancelAllReplays() {
  replayTimers.forEach((timers) => timers.forEach((id) => clearTimeout(id)));
  replayTimers.clear();
}

function clearReplayScripts(username) {
  if (username) {
    delete replayScripts[username];
    log('SYS', `${username}: komut kaydı silindi.`);
  } else {
    replayScripts = {};
    log('SYS', 'Tüm hesapların komut kaydı silindi.');
  }
  saveReplayScripts();
}

// ─── YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────────

function timestamp() {
  return new Date().toLocaleTimeString('tr-TR');
}

// Konsol açıkken yazılan satırı koru.
// SORUN: log() doğrudan console.log yazıyordu. Kullanıcı isteme (prompt)
// yazarken bir chat mesajı geldiğinde ekrana yeni satır basılıyor, readline
// yazdığı metni görsel olarak siliyordu; kullanıcı yazmaya devam edip Enter'a
// bastığında ise readline'da hâlâ duran TAM komut gönderiliyordu — yani
// ekranda görünmeyen bir komut sessizce çalışıyordu.
// ÇÖZÜM: log yazmadan önce o anki satırı ve imleci sakla, log'u bas, sonra
// satırı ve imleci geri koy.
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

  // Konsol etkinse ve kullanıcı bir şey yazıyorsa satırı koru
  const active = rl && consoleStarted && !pendingQuestion;
  let savedLine = null;
  let savedPos = 0;
  if (active) {
    savedLine = rl.line || '';
    savedPos = typeof rl.cursor === 'number' ? rl.cursor : savedLine.length;
    try { rl.clearLine(0); rl.cursorTo(0); } catch (_) {}
  }

  console.log(line);

  if (active) {
    try {
      rl.write(savedLine);
      if (typeof rl.cursor === 'number' && savedPos <= savedLine.length) rl.cursor = savedPos;
    } catch (_) {}
  }

  if (CONFIG.logFile && (type === 'CHAT' || type === 'BOT')) {
    const raw = `[${timestamp()}] [${type}] ${msg}\n`;
    fs.appendFileSync(CONFIG.logFile, raw, 'utf8');
  }
}

// ─── GİDEN KOMUT KUYRUĞU (TOPLU BOTLARDA FLOOD KORUMASI) ─────────────────────
// SORUN: 100+ hesap aynı anda bağlıyken /login, /cmd, /msg komutları aynı
//        milisaniyede gidiyordu. Sunucunun anti-bot/AuthMe eklentileri bunu
//        "komut spam'i / saldırı" olarak algılayıp bağlantıları atabiliyor.
// ÇÖZÜM: TÜM giden komutlar TEK bir kuyruktan geçer. Kuyruk, komutlar arasına
//        CONFIG.action.spacingMs (varsayılan 50 ms) + rastgele jitter koyar.
//        Böylece 100 bot aynı saniyede 100 komut yerine saniyede ~20 komut
//        gönderir; desen de sabit olmadığı için bot gibi görünmez.
//
// KULLANIM: bot.chat(...) yerine queueChat(bot, metin, kullaniciAdi) çağır.
const outbox = {
  queue:    [],    // { botInstance, text, username, at }
  timer:    null,
  lastSendAt: 0,
};

function outboxGap() {
  const base   = Math.max(0, Number(CONFIG.action.spacingMs) || 0);
  const jitter = Math.max(0, Number(CONFIG.action.jitterMs) || 0);
  return base + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0);
}

// Giden komutu kuyruğa alır (bot.chat'in yerine geçer).
function queueChat(botInstance, text, username) {
  if (!botInstance || typeof botInstance.chat !== 'function' || !text) return false;
  const limit = Math.max(1, Number(CONFIG.action.maxQueue) || 2000);
  if (outbox.queue.length >= limit) outbox.queue.shift(); // taşarsa en eski düşer
  outbox.queue.push({
    botInstance,
    text,
    username: username || '?',
    at: Date.now(),
  });
  scheduleOutbox();
  return true;
}

function scheduleOutbox() {
  if (outbox.timer || outbox.queue.length === 0) return;
  const wait = Math.max(0, outbox.lastSendAt + outboxGap() - Date.now());
  outbox.timer = setTimeout(flushOutbox, wait);
}

function flushOutbox() {
  outbox.timer = null;
  const item = outbox.queue.shift();
  if (!item) return;

  const expire = Math.max(1000, Number(CONFIG.action.expireMs) || 20000);
  // Bağlantı koptuktan sonra saatlerce bekleyen komutları göndermeyelim.
  if (Date.now() - item.at <= expire) {
    try {
      if (item.botInstance && typeof item.botInstance.chat === 'function') {
        item.botInstance.chat(item.text);
        outbox.lastSendAt = Date.now();
      }
    } catch (err) {
      log('WARN', `Komut gönderilemedi (${item.username}): ${err.message}`);
    }
  }

  if (outbox.queue.length > 0) scheduleOutbox();
}

function outboxStatus() {
  const jitter = Number(CONFIG.action.jitterMs) || 0;
  return `${CONFIG.action.spacingMs} ms` + (jitter > 0 ? ` (+0-${jitter} ms rastgele)` : '');
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
║   /kayit        → Kayıtlı komut dizisini göster (ac / kapat / sil)                                    ║
║   /kop          → Bağlantıyı bilerek düşür (yeniden bağlanmayı test)                                   ║
║   /aralik <ms>  → Giden komutlar arası bekleme (varsayılan 50 ms)                                     ║
║   /quit         → Botu kapat                                                                          ║
╚═══════════════════════════════════════════════════════════════════════════════════════════════════════╝
${C.reset}`);
}

// ─── OTOMATİK YENİDEN BAĞLANMA ───────────────────────────────────────────────
// ÖNEMLİ: bot.js'in en kritik eksiği buydu. Sunucu bir hesabı atınca
// ("zaten bağlısın", bağlantı kopması, timeout) o hesap kalıcı olarak ölü
// kalıyordu — CONFIG.reconnect/reconnectDelay tanımlıydı ama HİÇ kullanılmıyordu.
// Burada hesap başına üstel geri çekilmeli (backoff) yeniden bağlanma var.

const reconnectTimers = new Map(); // username → setTimeout id

function cancelReconnects() {
  reconnectTimers.forEach((id) => clearTimeout(id));
  reconnectTimers.clear();
  cancelAllReplays();
}

// Sunucu atılma sebebi bazen NBT biçiminde JSON metni olarak gelir:
//   {"type":"compound","value":{"extra":{"type":"list","value":{"type":"string",
//    "value":"Server closed"}}}}   veya   "value":[{"type":"string","value":"test"}]
// Böyle bir metni düz yazarsan log okunamaz hale gelir. İçindeki tüm
// "value" metinlerini sırayla topla.
function nbtMetinleri(nbt) {
  const parcalar = [];
  const gez = (n) => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') { parcalar.push(n); return; }
    if (typeof n === 'number' || typeof n === 'boolean') return;
    if (Array.isArray(n)) { n.forEach(gez); return; }
    if (typeof n === 'object') {
      // Düğüm biçimi: { type, value }
      if (Object.prototype.hasOwnProperty.call(n, 'value')) {
        if (typeof n.value === 'string') { parcalar.push(n.value); return; }
        gez(n.value);
        return;
      }
      Object.keys(n).forEach((k) => {
        if (k !== 'type' && k !== 'color' && k !== 'bold' && k !== 'italic'
            && k !== 'underlined' && k !== 'strikethrough' && k !== 'obfuscated') {
          gez(n[k]);
        }
      });
    }
  };
  try { gez(JSON.parse(nbt)); } catch (_) { return []; }
  return parcalar;
}

// Sunucu atılma sebebini DÜZ METNE çevir.
// mineflaver bu sebebi bazen string, bazen JSON/ChatMessage nesnesi olarak
// verir. Nesne doğrudan şablona yazılırsa "[object Object]" görünür; NBT
// JSON'u yazılırsa okunamaz bir blob görünür. İkisini de düzleştir.
function kickSebebi(reason) {
  const bos = 'sebep belirtilmedi';
  if (reason === null || reason === undefined) return bos;

  // 1) Nesne ise düz metne çevirmeye çalış
  if (typeof reason === 'object') {
    // ChatMessage vb. sınıflar toString() ile düz metni verir
    if (typeof reason.toString === 'function' && reason.toString !== Object.prototype.toString) {
      try {
        const s = reason.toString();
        if (typeof s === 'string' && s.trim() && s !== '[object Object]') return s.trim();
      } catch (_) { /* aşağıdaki alanlara düş */ }
    }
    if (typeof reason.text === 'string' && reason.text.trim()) return reason.text.trim();
    if (Array.isArray(reason.extra)) {
      const parcalar = reason.extra
        .map((p) => (typeof p === 'string' ? p : (p && (p.text || p.insertion)) || ''))
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (parcalar.length) return parcalar.join(' ').trim();
    }
    try {
      const s = JSON.stringify(reason);
      if (s && s !== '{}') return kickSebebi(s);
    } catch (_) { /* döngüsel nesne → aşağıdaki fallback */ }
    return bos;
  }

  // 2) String: NBT JSON mu? içindeki metinleri topla
  const s = String(reason).trim();
  if (!s) return bos;
  if (s.startsWith('{') || s.startsWith('[')) {
    const parcalar = nbtMetinleri(s)
      .map((p) => p.trim())
      .filter((p) => p && p !== '[object Object]');
    if (parcalar.length) return parcalar.join(' ');
  }
  return s === '[object Object]' ? bos : s;
}

// Hesabın sunucu tarafından "halen bağlı" sayılıp atılması genelde
// eski oturumun kapanmasını beklemek gerektirir → daha uzun bekle.
function isDuplicateLoginKick(reason) {
  const t = String(reason || '').toLowerCase();
  return t.includes('zaten ba') || t.includes('already connected')
      || t.includes('already logged') || t.includes('duplicate');
}

// Üstel geri çekilme: 10s, 15s, 23s, 34s, 51s, 76s, 114s ... en fazla 120s
// (Math.round yarım yukarı yuvarlar; 10*1.5^2 = 22.5 → 23)
// DİKKAT: scheduleReconnect bu fonksiyonu çağırmadan ÖNCE retryCount'u artırır.
// O yüzden buradaki n, "bu deneme kaçıncı" demektir: 1 → 10s, 2 → 15s, 3 → 22s ...
// (retryCount+1 kullanılırsa merdiven bir kademe kayıp hep 15s'den başlardı.)
function getReconnectDelay(account, extraDelaySec = 0) {
  const base = Math.max(2, CONFIG.reconnectDelay);
  const cap  = Math.max(base, CONFIG.reconnectMaxDelay);
  const n    = Math.max(1, Number(account.retryCount) || 1);
  let delay = Math.min(cap, Math.round(base * Math.pow(1.5, n - 1)));
  if (extraDelaySec > 0) delay = Math.min(cap + extraDelaySec, delay + extraDelaySec);
  return delay;
}

function scheduleReconnect(account, reason, extraDelaySec = 0) {
  const username = account.username || CONFIG.username;
  if (!CONFIG.reconnect || intentionalStop) return;
  // Aynı hesap için zaten bir yeniden deneme kuyruğa alınmışsa tekrar kuyruğa alma
  if (reconnectTimers.has(username)) return;

  account.retryCount = (account.retryCount || 0) + 1;
  const delay = getReconnectDelay(account, extraDelaySec);
  // Her hesap farklı bir anda denesin (toplu bağlanma fırtınası olmasın)
  const jitter = Math.floor(Math.random() * 3000);

  log('WARN', `${username}: ${reason} → ${delay}s sonra yeniden denenecek (deneme ${account.retryCount})`);

  const id = setTimeout(() => {
    reconnectTimers.delete(username);
    if (intentionalStop) return;

    // Hicbir zaman giris yapamadiysa siradaki surumu dene
    // (1.20.1 çalışmazsa 1.21.1, 1.21.7, 1.19.4 ...)
    const list = versionCandidatesFor(account);
    if (!account.everConnected && typeof account.versionIndex === 'number'
        && account.versionIndex < list.length - 1) {
      account.versionIndex += 1;
      log('SYS', `${username}: sürüm ${C.bold}${list[account.versionIndex - 1]}${C.reset} başarısız, ${C.bold}${list[account.versionIndex]}${C.reset} deneniyor.`);
    }

    // Proxy'li modda ölü proxy ile tekrar denemek anlamsız → sıradaki proxy'ye geç
    if (CONFIG.proxy.enabled && account.proxy && proxyPool.length > 0
        && typeof account.failoversLeft === 'number' && account.failoversLeft > 0) {
      const next = getNextWorkingProxy();
      if (next) {
        if (CONFIG.proxy.blacklist) proxyBlacklist.add(`${account.proxy.host}:${account.proxy.port}`);
        account.proxy = next;
        account.failoversLeft -= 1;
        log('SYS', `${username}: yeni proxy ${next.host}:${next.port} ile yeniden bağlanılıyor...`);
      }
    }
    log('SYS', `${username}: yeniden bağlanılıyor...`);
    createBot(account);
  }, delay * 1000 + jitter);

  reconnectTimers.set(username, id);
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

// Soru sorarken konsol komutlarının yorumlanmasını engeller
// (readline 'line' olayı hem question() hem de komut handler'ını tetikler).
function askQuestion(text, callback) {
  ensureReadline();
  pendingQuestion = true;
  rl.question(text, (answer) => {
    pendingQuestion = false;
    callback(answer);
  });
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
  cancelAllFailovers();   // bekleyen proxy failover'ları iptal et (hayalet bot önlenir)
  cancelReconnects();     // bekleyen otomatik yeniden bağlanmaları iptal et
  intentionalStop = true; // bu kapanış kasıtlı: 'end' handler'ı tekrar bağlanmasın
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

  askQuestion(`${C.magenta}Hangi hesabı kullanmak istiyorsunuz? (1-${accounts.length}, all veya P): ${C.reset}`, (answer) => {
    const choiceText = answer.trim().toLowerCase();

    if (choiceText === 'p' || choiceText === 'proxy') {
      askQuestion(`${C.green}Kaç kaliteli proxy toplansın?${C.reset} ${C.dim}(boş = 30)${C.reset}: `, (numAnswer) => {
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

// ─── SUNUCU SÜRÜMÜ TESPİTİ ──────────────────────────────────────────────────
// Sorun: CONFIG.version sabit yazılıydı ('1.21.11'). Sunucu farklı bir
// sürümdeyse minecraft-protocol "Outdated client/server" ile bağlantıyı
// reddediyor ve hiçbir log satırı bunu açıkça söylemiyordu.
// Çözüm: giriş öncesi status ping at, sunucunun sürüm/protokolünü al, kurulu
// minecraft-data'da karşılığı olan en yakın sürümü seç.
function pickVersionFromPing(res) {
  const reported = res && res.version;
  if (!reported) return null;

  const candidates = [];

  // 1) Protokol numarasından kesin eşleşme (775 → 26.1.x gibi)
  const byProtocol = mcData.postNettyVersionsByProtocolVersion.pc[reported.protocol] || [];
  byProtocol.forEach((v) => candidates.push(v.minecraftVersion));

  // 2) Sunucunun kendi verdiği isimden ("1.21.11", "Paper 1.21.11", "26.2")
  const text = `${reported.name || ''}`;
  const nums = text.match(/(\d+\.\d+(?:\.\d+)?)/g) || [];
  nums.forEach((n) => {
    const v = mcData.versionsByMinecraftVersion.pc[n];
    if (v) candidates.push(v.minecraftVersion);
  });

  if (candidates.length === 0) return null;
  // Protokol eşleşmesini tercih et, yoksa isimden geleni kullan
  return byProtocol.length > 0 ? byProtocol[0].minecraftVersion : candidates[0];
}

// Bu sunucu 1.21.8+ sürümlerinde AuthMe'nin GÖRSEL giriş ekranını
// (configuration aşamasındaki show_dialog) gönderiyor ve yanıtlanmadığı için
// bağlantı hiç tamamlanmıyordu. 1.21.7 ve altında ekran yok, klasik
// "/login <şifre>" komutu çalışıyor. Bu yüzden sunucunun sürümünü körü körüne
// kullanmıyoruz: yapılandırılmış güvenli sürüm listesinden sırayla deniyoruz.
function versionCandidatesFor(account) {
  if (serverVersion) return [serverVersion]; // 'auto' mod: sunucunun kendi sürümü
  const list = [CONFIG.version].concat(CONFIG.versionFallbacks || []).filter(Boolean);
  return list;
}

function versionForAccount(account) {
  const list = versionCandidatesFor(account);
  const idx = Math.min(account ? (account.versionIndex || 0) : 0, list.length - 1);
  return list[idx];
}

async function detectServerVersion(proxy = null) {
  const target = { host: CONFIG.host, port: CONFIG.port, closeTimeout: 8000, noPongTimeout: 4000 };

  if (proxy) {
    let SocksClient;
    try { SocksClient = require('socks').SocksClient; } catch (_) { return null; }
    target.connect = (client) => {
      SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: proxy.type || 5 },
        command: 'connect',
        destination: { host: CONFIG.host, port: CONFIG.port },
        timeout: CONFIG.proxy.verifyTimeout,
      }).then((info) => {
        client.setSocket(info.socket);
        client.emit('connect');
      }).catch((err) => client.emit('error', err));
    };
  }

  try {
    const res = await mcProtocol.ping(target);
    const v = pickVersionFromPing(res);
    if (v) {
      log('SYS', `${C.green}✔ Sunucu sürümü algılandı:${C.reset} ${C.bold}${v}${C.reset} ${C.dim}(protokol ${res.version.protocol}, ${res.version.name})${C.reset}`);
    } else {
      log('WARN', `Sunucu sürümü çözümlenemedi (protokol ${res.version && res.version.protocol}). Kurulu kütüphane sürümünü güncellemek gerekebilir: npm update`);
    }
    return v;
  } catch (err) {
    log('WARN', `Sunucu sürümü pingi başarısız: ${err.message} ${C.dim}(sabit sürümle devam edilecek)${C.reset}`);
    return null;
  }
}

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

// ─── AYAR DOSYASI (ayarlar.json) ─────────────────────────────────────────────
// Komut aralığı / rastgele gecikme değerleri açılışta sorulur ve burada
// saklanır. Böylece her açılışta aynı değerleri yeniden yazmak gerekmez;
// sadece Enter'a basıp kayıtlı değerle devam edilir.
function settingsFilePath() {
  return path.join(__dirname, 'ayarlar.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFilePath(), JSON.stringify({
      actionSpacingMs:  CONFIG.action.spacingMs,
      actionJitterMs:   CONFIG.action.jitterMs,
      connectStaggerMs: CONFIG.connectStaggerMs,
      connectJitterMs:  CONFIG.connectJitterMs,
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (_) {}
}

// Kayıtlı ayarları CONFIG'e uygula (geçersiz değerler yok sayılır).
function applySavedSettings() {
  const s = loadSettings();
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const sp = num(s.actionSpacingMs, 0, 5000);
  const jt = num(s.actionJitterMs, 0, 1000);
  const cs = num(s.connectStaggerMs, 0, 60000);
  const cj = num(s.connectJitterMs, 0, 60000);
  if (sp !== null) CONFIG.action.spacingMs = sp;
  if (jt !== null) CONFIG.action.jitterMs = jt;
  if (cs !== null) CONFIG.connectStaggerMs = cs;
  if (cj !== null) CONFIG.connectJitterMs = cj;
  return s;
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
    startAccountsWithVersionCheck(accounts);
    return;
  }

  proxyPool = await loadAndVerifyProxies();

  if (proxyPool.length === 0) {
    log('WARN', `${C.yellow}Çalışan proxy bulunamadı, proxysiz bağlanılıyor.${C.reset}`);
    startAccountsWithVersionCheck(accounts);
    return;
  }

  log('SYS', `${C.green}✔ Proxy havuzu hazır: ${proxyPool.length} çalışan proxy.${C.reset}`);
  startAccountsWithVersionCheck(accounts);
}

function chooseProxyAndStart(selectedAccounts = null) {
  const accs = selectedAccounts || [];
  proxyVerifyLimit = loadProxyConfig().limit;

  if (!CONFIG.proxy.enabled) {
    askActionSettings(accs, () => startWithProxies(accs));
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

  askQuestion(`${C.green}Mod seç (0-4, boş bırakılırsa "${modName(remembered)}" kullanılır): ${C.reset}`, (answer) => {
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

// ─── AÇILIŞTA KOMUT ARALIĞI AYARI ───────────────────────────────────────────
// Ana girişte (hesap + proxy seçiminden sonra) sorulur. Enter'a basılırsa
// ayarlar.json'daki kayıtlı değer kullanılır. Böylece 100+ bot aynı anda
// komut gönderirken sunucunun bunu saldırı sanmasını kullanıcı kendisi
// ayarlayabilir.
function askActionSettings(accs, next) {
  ensureReadline();
  log('SYS', `${C.cyan}Komut aralığı ayarı${C.reset} ${C.dim}(Enter = kayıtlı değer, 0 = kapalı)${C.reset}`);

  askQuestion(`  Komut aralığı (ms) ${C.dim}[${CONFIG.action.spacingMs}]${C.reset}: `, (a1) => {
    const v1 = parseInt(a1.trim(), 10);
    if (Number.isFinite(v1) && v1 >= 0 && v1 <= 5000) {
      CONFIG.action.spacingMs = v1;
    } else if (a1.trim() !== '') {
      log('WARN', 'Geçersiz değer (0-5000), kayıtlı aralık kullanılıyor.');
    }

    askQuestion(`  Rastgele gecikme (ms) ${C.dim}[${CONFIG.action.jitterMs}]${C.reset}: `, (a2) => {
      const v2 = parseInt(a2.trim(), 10);
      if (Number.isFinite(v2) && v2 >= 0 && v2 <= 1000) {
        CONFIG.action.jitterMs = v2;
      } else if (a2.trim() !== '') {
        log('WARN', 'Geçersiz değer (0-1000), kayıtlı jitter kullanılıyor.');
      }

      saveSettings();
      log('SYS', `${C.green}✔${C.reset} Komut aralığı: ${C.bold}${outboxStatus()}${C.reset} ${C.dim}(ayarlar.json'a kaydedildi)${C.reset}`);
      next();
    });
  });
}

// Girişten önce: otomatik giriş şifresi + doğrulama proxy sayısı sorulur
// (şifre zaten kayıtlıysa sadece limit sorulur → daha hızlı başlangıç)
function askCredentialsAndLimit(accs) {
  ensureReadline();

  const askLimit = () => {
    if (proxyMode === 'direct') {
      askActionSettings(accs, () => startWithProxies(accs)); // doğrulama yok → limit sorusu atlanır
      return;
    }
    askQuestion(`${C.green}Doğrulama için kaç proxy?${C.reset} ${C.dim}(50≈1dk / 150≈2.5dk / 300≈5dk — boş = kayıtlı ${proxyVerifyLimit})${C.reset}: `, (limAnswer) => {
      const lim = parseInt(limAnswer.trim(), 10);
      if (!isNaN(lim) && lim >= 10 && lim <= 1000) {
        proxyVerifyLimit = lim;
        saveProxyConfig(proxyMode, proxyVerifyLimit);
        log('SYS', `Doğrulama sınırı: ${C.bold}${proxyVerifyLimit} proxy${C.reset}`);
      } else if (limAnswer.trim() !== '') {
        log('WARN', 'Geçersiz sayı (10-1000), kayıtlı limit kullanılıyor.');
      }
      askActionSettings(accs, () => startWithProxies(accs));
    });
  };

  const withPw = accs.filter((acc) => getPasswordFor(acc));
  if (withPw.length === accs.length) {
    log('SYS', `Şifreler kayıtlı${C.dim} (${withPw.length}/${accs.length})${C.reset} — değiştirmek için: /setpass`);
    askLimit();
    return;
  }

  askQuestion(`${C.green}Otomatik giriş şifresi${C.reset} ${C.dim}(boş = şifresiz; tek şifre tüm hesaplara uygulanır${C.reset}): `, (pwAnswer) => {
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
    queueChat(entry.bot, command, entry.username);
  }
  log('BOT', `${C.cyan}✔ ${entry.username}: otomatik ${kind} komutu gönderildi (deneme ${entry.authAttempts}/${MAX_AUTH_ATTEMPTS})${C.reset}`);
}

function tryAutoAuthFor(entry, text) {
  if (!entry) return;
  const password = getPasswordFor({ username: entry.username });
  if (!password) return;
  if (entry.isAuth || entry.authGiveUp) return;

  const registerPatterns = [/\/register/i, /kayıt ol/i, /henüz kayıtlı değil/i, /not registered/i];
  const loginPatterns    = [/\/login/i, /giriş yap/i, /lütfen giriş/i, /please login/i, /you (need|must) to ?login/i];
  const successPatterns  = [/giriş yaptın/i, /başarıyla giriş/i, /successfully logged in/i, /logged in successfully/i, /zaten giriş yap/i,
                           // Bu sunucu "Giriş başarılı." / "Giriş işlemin başarıyla gerçekleşti"
                           // gönderiyor; eski kalıplar bunu yakalamadığı için entry.isAuth
                           // hiç true olmuyordu (replay bu yüzden giriş bekleyemiyordu).
                           /giri[şs]\s*başarılı/i, /başarıyla gerçekleş/i, /giri[şs]\s*işlemin/i, /logged in/i];

  // ── 1) BAŞARI KONTROLÜ ÖNCE YAPILIR ──────────────────────────────────────
  // SORUN: Hız sınırı (AUTH_COOLDOWN_MS) başarı kontrolünden ÖNCE uygulanıyordu.
  // AuthMe, login komutundan hemen sonra "Giriş başarılı." mesajını AYNI milisaniyede
  // gönderiyor; bu yüzden başarı mesajı hız sınırına takılıp eleniyor ve
  // entry.isAuth hiç true olmuyordu (replay 9 sn bekleyip zaman aşımına düşüyordu).
  // Başarı tespiti ASLA hız sınırına tabi olmamalıdır.
  if (successPatterns.some((p) => p.test(text))) {
    entry.isAuth = true;
    log('SYS', `${C.green}✔ ${entry.username}: otomatik giriş başarılı.${C.reset}`);
    return;
  }

  // ── 2) Sonra hız sınırı (aynı komutu saniyede onlarca kez atmayalım) ─────
  const now = Date.now();
  if (now - (entry.lastAuthAttempt || 0) < AUTH_COOLDOWN_MS) return;

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
        queueChat(entry.bot, CONFIG.autoChat.message, entry.username);
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

  // ── GÜVENLİK KİLİDİ ──────────────────────────────────────────────────────
  // BOT_MAX=1 ile çalıştırıldığında 1'den fazla hesap seçilirse bot HİÇ
  // bağlanmaz ve kapanır. (Testte yanlışlıkla canlı sunucuya 100 bot
  // gönderilmesini kesin olarak engeller.)
  if (BOT_MAX_ACCOUNTS > 0 && accounts.length > BOT_MAX_ACCOUNTS) {
    log('ERROR', `${C.red}✖ BOT_MAX=${BOT_MAX_ACCOUNTS} sınırı aşıldı${C.reset} — ${accounts.length} hesap seçildi. Bot başlatılmıyor.`);
    log('INFO', `  Sınır: en fazla ${BOT_MAX_ACCOUNTS} hesap. Daha fazlası için BOT_MAX tanımlamadan çalıştır.`);
    log('INFO', `  Hedef: ${CONFIG.host}:${CONFIG.port} (sürüm ${CONFIG.version})`);
    process.exit(1);
    return;
  }

  if (ENV_OVERRIDES.length > 0) {
    log('SYS', `${C.yellow}Test ortamı aktif${C.reset} ${C.dim}(${ENV_OVERRIDES.join(' ')})${C.reset} → ${C.bold}${CONFIG.host}:${CONFIG.port}${C.reset} ${C.dim}v${CONFIG.version}, ${accounts.length} hesap${C.reset}`);
  }

  // Kasıtlı bir kapanıştan sonra yeniden başlatma: otomatik yeniden
  // bağlanmayı yeniden aç ve eski sayaçları sıfırla.
  intentionalStop = false;
  cancelReconnects();

  selectedAccounts = accounts;

  // Proxy havuzu varsa hesaplara dağıt
  if (proxyPool.length > 0) {
    selectedAccounts = assignProxies(selectedAccounts, proxyPool, proxyMode);
    log('SYS', `${C.dim}Dağıtım: ${modName(proxyMode)} (${proxyPool.length} proxy / ${selectedAccounts.length} hesap)${C.reset}`);
  } else {
    selectedAccounts = selectedAccounts.map((acc) => ({ ...acc, proxy: null }));
  }

  selectedAccounts.forEach((account, index) => {
    account.failoversLeft = CONFIG.proxy.maxFailovers;
    account.retryCount = 0;
    // 100 hesabı aynı anda bağlamak sunucuyu boğar (bağlantı resetleri,
    // "zaten bağlısın" atışları). Aralıkla dağıt; aralığa hafif rastgelelik
    // ekle ki botlar tam 0,500,1000 ms deseninde bağlanmasın.
    const stagger = Math.max(0, Number(CONFIG.connectStaggerMs) || 0);
    const connJitter = Math.max(0, Number(CONFIG.connectJitterMs) || 0);
    if (stagger > 0 && index > 0) {
      const at = index * stagger + (connJitter > 0 ? Math.floor(Math.random() * (connJitter + 1)) : 0);
      setTimeout(() => createBot(account), at);
    } else {
      createBot(account);
    }
  });
}

// Sürüm 'auto' ise hesapları başlatmadan önce sunucunun sürümünü öğren.
// (Sunucu farklı sürümdeyse sabit sürümle bağlantı hiç açılmıyordu.)
function startAccountsWithVersionCheck(accounts) {
  // 'auto' sadece kullanıcı açıkça isterse sunucunun sürümü tespit edilir.
  // Bu sunucu 1.21.8+ olduğu için otomatik seçim görsel giriş ekranı
  // sorununu geri getirir; varsayılan güvenli sürüm (1.20.1) kullanılır.
  if (CONFIG.version !== 'auto' || serverVersion) {
    startAccounts(accounts);
    return;
  }

  const sample = (proxyPool.length > 0 && proxyMode === 'per-account' && proxyPool[0])
    ? proxyPool[0]
    : null;

  detectServerVersion(sample).then((v) => {
    serverVersion = v || CONFIG.fallbackVersion || null;
    if (!serverVersion) {
      log('WARN', `${C.yellow}Sürüm tespit edilemedi; kurulu kütüphanenin en güncel sürümü kullanılacak.${C.reset}`);
    }
    startAccounts(accounts);
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
    // Gövde: 'auto' değilse yapılandırılmış sürüm listesinden seçilir.
    // (Sunucu 1.21.8+ olduğu için sunucunun kendi sürümü kullanılmıyor.)
    version:  versionForAccount(selectedAccount),
    username,
    auth:     CONFIG.auth,
    // Sunucu cevap vermezse sonsuza kadar asılı kalmak yerine hata ver
    checkTimeoutInterval: CONFIG.checkTimeout,
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
      // DİKKAT: Sunucu (/spawn, /skyblock gibi ışınlamalarda) AYNI bağlantı
      // için login paketini yeni entity id ile tekrar gönderiyor. Bu yeni bir
      // bağlantı DEĞİL, sadece respawn. Her seferinde "bağlantı kuruldu"
      // yazmak yanlış oluyordu (ve komutlar iki kez gönderiliyordu).
      const oldId = entry.entityId;
      entry.entityId = currentBot.entity ? currentBot.entity.id : null;
      if (entry.loginHandled) {
        if (oldId !== entry.entityId) {
          log('INFO', `${C.dim}${currentBot.username} yeniden doğdu (entity ${oldId} → ${entry.entityId})${C.reset}`);
        }
        return;
      }
      entry.loginHandled = true;

      entry.connected = true;
      isConnected = true;
      const viaProxy = entry.proxy ? ` | ${C.cyan}IP: ${entry.proxy.host}:${entry.proxy.port}${C.reset}` : '';
      log('SYS', `${C.green}✔ Bağlantı kuruldu!${C.reset} Oyuncu: ${C.bold}${currentBot.username}${C.reset}${viaProxy}`);

      entry.isAuth = false;
      entry.authGiveUp = false;
      entry.authAttempts = 0;
      entry.lastAuthAttempt = 0;
      // Bağlantı kuruldu → bu oturum temiz. Yeniden bağlanma sayacı ve
      // failover kilidi sıfırlanır (aksi halde ilk hatadan sonra bir daha
      // failover tetiklenmiyordu).
      entry.failoverHandled = false;
      if (selectedAccount) {
        selectedAccount.retryCount = 0;
        selectedAccount.everConnected = true;
        selectedAccount.versionIndex = 0;
      }
      lastLogged.delete(username);

      startConsole();

      // Bağlantı geri geldi → AuthMe girişi bitince kayıtlı komut dizisini
      // tekrar oynat (örn. /login 1234, /skyblock … "eski haline dönme")
      scheduleReplayAfterAuth(entry, currentBot);

      if (CONFIG.autoChat.enabled && !autoChatTimer) {
        startAutoChat(CONFIG.autoChat.intervalSeconds, CONFIG.autoChat.message);
      }
    });

    // Aynı mesajın tekrar tekrar basılmasını engelle.
    //
    // SORUN 1: Sunucu bazı mesajları saniyede 10-15 kez tekrar ediyor. Üstelik
    //           İKİ farklı mesaj dönüşümlü geliyordu (A,B,A,B). "son tek metin"
    //           tutulduğu için A'nın tekrarı hiç yakalanmıyordu.
    // SORUN 2: Aynı mesaj hem 'chat' hem 'message' olayıyla geliyor ve ÜSTELİK
    //           farklı biçimde yazılıyordu:
    //               [INFO] [AO] ⇴ Oyuncu Görünümü: Tüm Oyuncular!
    //               [CHAT] AO:  ⇴ Oyuncu Görünümü: Tüm Oyuncular!
    //               [INFO] AtlasOyuncu ⚠ Yerdeki tüm itemler kaldırıldı !
    //               [CHAT] AtlasOyuncu: Yerdeki tüm itemler kaldırıldı !
    //           Metin birebir aynı olmadığı için sadece string karşılaştırması
    //           yetmiyordu; GÖNDEREN ÖNEKİ + AYRACI soyutlanarak kanıtlanıyor.
    //
    // ÇÖZÜM: Mesajı gönderen önekinden arındırıp tek anahtara indirge, hesap
    // başına son N anahtarı zaman damgalarıyla tut, pencere içinde listelenen
    // HERHANGİ biriyle eşleşirse basma.
    // Mesajın tek anahtarını döndürür: "<gönderen>\0<gövde>".
    // Gönderen adı korunur (iki farklı oyuncunun AYNI mesajı ikisi de görünür),
    // yalnızca AYRAK biçimi (": " / " ⚠ " / " › ") ve köşeli önek soyutlanır.
    function mesajAnahtari(text) {
      const t = String(text).trim();
      if (!t) return '';

      // Gövdenin başındaki/sonundaki dekoratif karakterleri (emoji, "!", "»",
      // "⭐", boşluk) at. Bunlar aynı mesajın iki biçiminde farklı görünebilir
      // ve karşılaştırmayı bozuyordu.
      const govde = (s) => String(s)
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/[^\p{L}\p{N}]+$/u, '')
        .trim();

      // 1) "[AO] mesaj" → "ao\0mesaj"
      const koseli = t.match(/^\[([^\]]{1,32})\]\s*([\s\S]+)$/);
      if (koseli) {
        const g = govde(koseli[2]);
        if (g) return koseli[1].trim().toLowerCase() + '\u0000' + g;
      }

      // 2) "AO: mesaj" / "AtlasOyuncu ⚠ mesaj" / "Sunucu - mesaj" → "gonderen\0mesaj"
      //    Gönderen adı harf/rakam/alt çizgiden (2-24 karakter) oluşur, ardından
      //    kısa bir ayraç gelir. Ayraç ":" olabileceği gibi ⚠, ›, * gibi bir sembol
      //    ya da düz bir boşluk da olabilir; bu yüzden ayraç "harf veya rakam
      //    olmayan 1-6 karakter" olarak alınıyor.
      const onEk = t.match(/^([A-Za-z0-9_]{2,24})\s*([^\p{L}\p{N}]{1,6})\s+([\s\S]+)$/u);
      if (onEk) {
        const g = govde(onEk[3]);
        if (g) return onEk[1].toLowerCase() + '\u0000' + g;
      }

      // 3) Gönderen yok → sunucu/sistem mesajı
      const g3 = govde(t);
      return g3 ? '\u0000' + g3 : '';
    }

    function mesajTekrarMi(username, text) {
      const key = mesajAnahtari(text);
      if (!key) return true;

      const now = Date.now();
      const win = CONFIG.chat.dedupeWindowMs;
      let list = lastLogged.get(username);

      if (!Array.isArray(list)) { list = []; lastLogged.set(username, list); }

      // Süresi dolmuşları temizle
      list = list.filter((it) => (now - it.at) < win);

      if (list.some((it) => it.text === key)) {
        lastLogged.set(username, list);
        return true; // pencere içinde basılmış → tekrar
      }

      list.push({ text: key, at: now });
      while (list.length > CONFIG.chat.dedupeKeep) list.shift();
      lastLogged.set(username, list);
      return false;
    }

    currentBot.on('chat', (sender, message) => {
      if (sender === currentBot.username) return;
      // mineflayer aynı oyuncu mesajını 'chat' ve 'message' olaylarıyla iki kez
      // yayıyordu → ekranda hem [CHAT] hem [INFO] olarak çift basılıyordu.
      if (mesajTekrarMi(username, `${sender}: ${message}`)) return;
      const entryText = `${C.yellow}${sender}${C.reset}: ${message}`;
      chatHistory.push({ username: sender, message, time: timestamp() });
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      log('CHAT', entryText);
      tryAutoAuthFor(entry, message);
    });

    currentBot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      // 'chat' olayı zaten bu mesajı bastıysa tekrar basma
      if (mesajTekrarMi(username, text)) return;
      log('INFO', `${C.dim}${text}${C.reset}`);
      tryAutoAuthFor(entry, text);
    });

    currentBot.on('kicked', (reason) => {
      entry.connected = false;
      isConnected = isAnyBotConnected();
      // Sebep nesne olabilir; düz metne çevirmeden yazılırsa "[object Object]" görünür.
      const sebep = kickSebebi(reason);
      log('WARN', `Sunucudan atıldı: ${C.red}${sebep}${C.reset}`);
      // ESKİ DAVRANIŞ: sadece loglanıyordu, hesap bir daha denemiyordu.
      // Sunucu "zaten bağlısın" derse eski oturumun düşmesi beklenir.
      scheduleReconnect(selectedAccount, `sunucudan atıldı: ${sebep}`, isDuplicateLoginKick(sebep) ? 20 : 0);
    });

    currentBot.on('error', (err) => {
      entry.connected = false;
      isConnected = isAnyBotConnected();
      if (CONFIG.proxy.enabled && selectedAccount.proxy && typeof selectedAccount.failoversLeft === 'number' && selectedAccount.failoversLeft > 0 && !entry.failoverHandled && proxyPool.length > 0) {
        entry.failoverHandled = true;
        handleProxyFailover(selectedAccount, selectedAccount.failoversLeft, err);
      } else {
        log('ERROR', err.message);
        scheduleReconnect(selectedAccount, `bağlantı hatası: ${err.message}`);
      }
    });

    currentBot.on('end', (reason) => {
      entry.connected = false;
      isConnected = isAnyBotConnected();
      if (CONFIG.proxy.enabled && selectedAccount.proxy && typeof selectedAccount.failoversLeft === 'number' && selectedAccount.failoversLeft > 0 && !entry.failoverHandled && proxyPool.length > 0) {
        entry.failoverHandled = true;
        handleProxyFailover(selectedAccount, selectedAccount.failoversLeft, new Error('bağlantı kesildi'));
      } else {
        // ESKİ DAVRANIŞ: sadece loglanıyordu. Doğrudan (proxysiz) modda
        // hesap bir daha hiç bağlanmıyordu → bot zamanla tamamen ölüyordu.
        log('WARN', 'Bağlantı kesildi.');
        scheduleReconnect(selectedAccount, `bağlantı kesildi${reason ? ` (${reason})` : ''}`);
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
  ensureReadline();
  rl.setPrompt(`${C.green}> ${C.reset}`);

  // 'line' dinleyicisi SADECE BİR KEZ bağlanır. /hesap komutu
  // consoleStarted=false yapıp startConsole()'u tekrar çağırıyordu; her
  // çağrıda yeni bir 'line' dinleyicisi ekleniyordu → komutlar iki kez
  // işleniyordu (ör. /afk açıp kapanıyor, /drop slot 3 iki kez atıyordu).
  if (!consoleBound) {
    consoleBound = true;
    consoleStarted = true;

    rl.on('line', (line) => {
      // Bir soru soruluyorken girilen satır komut değildir.
      if (pendingQuestion) return;
      handleConsoleLine(line);
    });

    rl.on('close', () => {
      log('SYS', 'Konsol kapatıldı.');
      process.exit(0);
    });
  }

  consoleStarted = true;
  rl.prompt();
}

function handleConsoleLine(line) {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/msg ')) {
      const msg = input.slice(5);
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) { log('WARN', 'Bağlı hesap yok!'); }
      else {
        connectedEntries.forEach((entry) => {
          queueChat(entry.bot, msg, entry.username);
          // "Eski haline dönme": sohbet kaydı istenirse hesaba yaz
          recordStep(entry.username, 'chat', msg);
        });
        log('BOT', `${C.bold}Sen${C.reset}: ${msg} (${connectedEntries.length} hesap)`);
      }

    } else if (input.startsWith('/cmd ')) {
      const cmd = input.slice(5);
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) { log('WARN', 'Bağlı hesap yok!'); }
      else {
        connectedEntries.forEach((entry) => {
          queueChat(entry.bot, `/${cmd}`, entry.username);
          // Bağlantı koptuğunda aynı komut tekrar gönderilsin (/login, /skyblock …)
          recordStep(entry.username, 'cmd', `/${cmd}`);
        });
        log('BOT', `Komut: /${cmd} (${connectedEntries.length} hesap)${CONFIG.replay.enabled ? C.dim + '  ⟳ kaydedildi' + C.reset : ''}`);
      }

    } else if (input === '/kayit' || input === '/replay') {
      const connectedEntries = getConnectedBots();
      log('SYS', `Komut kaydı: ${C.bold}${CONFIG.replay.enabled ? 'AÇIK' : 'KAPALI'}${C.reset}`);
      log('INFO', `  Her yeniden bağlanışta kayıtlı komutlar tekrar gönderilir. Kayıt dosyası: ${CONFIG.replay.file}`);
      if (connectedEntries.length > 0) {
        connectedEntries.forEach((entry) => {
          const steps = replayScripts[entry.username] || [];
          log('INFO', `  ${C.bold}${entry.username}${C.reset}: ${steps.length ? steps.map((s) => s.text).join(' → ') : C.dim + '(kayıt yok)' + C.reset}`);
        });
      }

    } else if (input === '/kop' || input === '/drop-conn') {
      // Bağlantıyı bilerek düşür → otomatik yeniden bağlanma + komut tekrarını
      // test etmek için. (Sunucu hâlâ hesabı dolu sanabilir, sıra bekler.)
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) { log('WARN', 'Bağlı bot yok!'); }
      else {
        connectedEntries.forEach((entry) => {
          const sec = Math.round(entry.account.retryCount >= 0
            ? getReconnectDelay(entry.account, 0) : CONFIG.reconnectDelay);
          try {
            entry.bot.quit('bilerek düşürüldü');
            log('WARN', `${entry.username} bağlantısı düşürüldü → ${sec} sn sonra otomatik geri geliyor, kayıtlı komutlar tekrar oynatılacak.`);
          } catch (err) {
            log('ERROR', `Bağlantı düşürülemedi: ${err.message}`);
          }
        });
      }

    } else if (input === '/kayit sil' || input === '/replay sil') {
      const connectedEntries = getConnectedBots();
      if (connectedEntries.length === 0) clearReplayScripts(null);
      else connectedEntries.forEach((entry) => clearReplayScripts(entry.username));

    } else if (input === '/kayit ac' || input === '/replay ac') {
      CONFIG.replay.enabled = true;
      log('SYS', `Komut kaydı ${C.green}AÇILDI${C.reset} — bağlantı kopunca komutlar tekrar gönderilecek.`);

    } else if (input === '/kayit kapat' || input === '/replay kapat') {
      CONFIG.replay.enabled = false;
      log('SYS', `Komut kaydı ${C.yellow}KAPATILDI${C.reset}.`);

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
  Komut Aralığı : ${outboxStatus()} ${C.dim}(kuyruk: ${outbox.queue.length})${C.reset}
  Bağlantı Ara. : ${CONFIG.connectStaggerMs} ms (+0-${CONFIG.connectJitterMs} ms rastgele)
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

    } else if (input === '/aralik') {
      log('SYS', `Giden komutlar arası bekleme: ${C.bold}${outboxStatus()}${C.reset}`);
      log('INFO', `Bağlantı aralığı: ${CONFIG.connectStaggerMs} ms (+0-${CONFIG.connectJitterMs} ms rastgele)`);
      log('INFO', `Şu an kuyrukta ${outbox.queue.length} komut var. Bağlı bot: ${getConnectedBots().length}.`);
      log('INFO', 'Değiştir: /aralik <ms>  |  /aralik jitter <ms>  |  /aralik baglanti <ms>   (0 = kapalı)');

    } else if (input.startsWith('/aralik ')) {
      const rest = input.slice('/aralik '.length).trim();
      const parts = rest.split(/\s+/);
      const sub = (parts[0] || '').toLowerCase();

      if (sub === 'jitter' || sub === 'rastgele') {
        const v = parseInt(parts[1], 10);
        if (!Number.isFinite(v) || v < 0 || v > 1000) {
          log('WARN', 'Kullanım: /aralik jitter <0-1000>  (ms)');
        } else {
          CONFIG.action.jitterMs = v;
          saveSettings();
          log('SYS', `${C.green}✔${C.reset} Rastgele gecikme ${C.bold}${v} ms${C.reset} olarak ayarlandı ${C.dim}(ayarlar.json)${C.reset}`);
        }

      } else if (sub === 'baglanti' || sub === 'bağlantı') {
        const v = parseInt(parts[1], 10);
        if (!Number.isFinite(v) || v < 0 || v > 60000) {
          log('WARN', 'Kullanım: /aralik baglanti <0-60000>  (ms)');
        } else {
          CONFIG.connectStaggerMs = v;
          saveSettings();
          log('SYS', `${C.green}✔${C.reset} Bağlantı aralığı ${C.bold}${v} ms${C.reset} olarak ayarlandı ${C.dim}(bir sonraki bağlanmada geçerli)${C.reset}`);
        }

      } else {
        const val = parseInt(rest, 10);
        if (!Number.isFinite(val) || val < 0 || val > 5000) {
          log('WARN', 'Kullanım: /aralik <0-5000>  (ms)');
        } else {
          CONFIG.action.spacingMs = val;
          // 0 → korumayı tamamen kapat; pozitif değerde jitter geri gelir.
          CONFIG.action.jitterMs = val === 0 ? 0 : (CONFIG.action.jitterMs || 25);
          saveSettings();
          log('SYS', `${C.green}✔${C.reset} Komut aralığı ${C.bold}${val} ms${C.reset} olarak ayarlandı` +
            (CONFIG.action.jitterMs > 0 ? ` (+0-${CONFIG.action.jitterMs} ms rastgele).` : ' (rastgele gecikme kapalı).'));
        }
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
      log('INFO', '/msg /cmd /mine /stop /afk /ileri /geri /sag /sol /drop slot N /drop all /setpass /toplu /pass /proxycount /autochat /aralik /info /proxies /history /hesap /reconnect /kayit [ac|kapat|sil] /quit');
    }

    rl.prompt();
}

// ─── BAŞLAT ──────────────────────────────────────────────────────────────────

authPasswords = loadAuthPasswords();
applySavedSettings();
loadReplayScripts();
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
