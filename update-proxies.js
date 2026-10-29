/**
 * ═══════════════════════════════════════════════════════════
 * ADI    : update-proxies.js
 * GÖREV  : Bot kapalıyken GitHub'dan taze proxy listesi çeker,
 *          hedef sunucuya MINECRAFT STATUS PING (gerçek MC protokolü)
 *          ile doğrular ve çalışanları proxy.txt'ye yazar. (tek seferlik araç)
 * KULLANIM: node update-proxies.js
 * BAGLANTILAR:
 *   AĞ   : GitHub raw URL'leri (HTTPS GET) → proxy listeleri
 *   AĞ   : CONFIG.host:CONFIG.port         → MC status ping doğrulama
 *   DOSYA: proxy.txt (yazma)               → çalışan proxy havuzu
 * BAĞIMLI: proxy-lib.js, https (node içi), socks
 * ═══════════════════════════════════════════════════════════
 */

// ─── HEDEF (DOĞRULANACAK) SUNUCU ────────────────────────────────────────────
// bot.js CONFIG.host/port ile aynı tutulmalıdır.
const HOST = 'mc.atlasoyuncu.com';
const PORT = 25565;

const VERIFY_TIMEOUT      = 7000; // proxy başına doğrulama zaman aşımı (ms)

// Kullanım: node update-proxies.js [doğrulanacak_proxy_sayısı]  (ör: node update-proxies.js 150)
const PROXY_SOURCES_LIMIT = Math.min(Math.max(parseInt(process.argv[2], 10) || 250, 1), 1000);

const proxyLib = require('./proxy-lib.js');

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`);
}

(async () => {
  log('GitHub kaynaklarından proxy listesi çekiliyor...');
  const { proxies: raw, totalRaw, statuses } = await proxyLib.fetchProxiesFromGithub();

  for (const s of statuses) {
    log(`  ${s.ok ? '✓' : '✗'} ${s.url} (${s.count} satır)`);
  }
  log(`Toplam proxy (tekrarsız): ${raw.length} (ham satır: ${totalRaw})`);

  // Havuzu sınırla (sunucuya gereksiz yük olmasın)
  const limited = proxyLib.getRandomSubarray(raw, PROXY_SOURCES_LIMIT);
  log(`Doğrulama için seçildi: ${limited.length} proxy → ${HOST}:${PORT}`);

  const working = await proxyLib.verifyProxiesMinecraft(limited, HOST, PORT, VERIFY_TIMEOUT, (done, total, ok) => {
    if (done % 50 === 0 || done === total) {
      log(`  Doğrulama: ${done}/${total} tarandı, ${ok} çalışan`);
    }
  });

  if (working.length === 0) {
    log('⚠  Hiç çalışan proxy bulunamadı. proxy.txt değiştirilmedi.');
    process.exit(1);
  }

  const file = proxyLib.writeProxyFile(__dirname, working);
  log(`✓ ${working.length} çalışan proxy → ${file} kaydedildi.`);
  log("Hazır: node bot.js çalıştırarak proxy.txt'yi kullanabilirsiniz (veya GitHub çekimi açıkken her açılışta yenilenir).");
  process.exit(0);
})().catch((err) => {
  log('HATA: ' + err.message);
  process.exit(1);
});