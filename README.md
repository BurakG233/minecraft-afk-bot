# mc-afk-bot

Minecraft AFK botu — mineflayer tabanlı, hesap seçici, proxy yönetimi ve otomatik yeniden bağlanma ile çalışır.

## Kurulum

Depoyu klonladıktan sonra bağımlılıkları yükle:

```bash
npm install
```

## Çalıştırma

Canlı sunucuya bağlanmak için:

```bash
npm start
```

Yerel test sunucusu için (127.0.0.1):

```bash
npm run start:local
```

`npm start` varsayılan olarak `bot.js` içindeki `CONFIG.host` (`mc.atlasoyuncu.com`) sunucusuna bağlanır. Ortam değişkeniyle geçersiz kılabilirsin:

```bash
set BOT_HOST=127.0.0.1&& set BOT_VERSION=1.21.11&& node bot.js
```

## İlk çalıştırma

- `hesaplar.json` yoksa ilk çalıştırmada örnek bir dosya oluşturulur; kendi Minecraft hesaplarını buraya ekle.
- `auth-passwords.json` (AuthMe şifreleri) ve proxy dosyaları çalışma anında yönetilir, repoya dahil edilmez (`.gitignore`'a bak).
- Proxy yoksa doğrudan bağlantı (`direct` modu) seçilebilir.

## Klasör yapısı

```
bot.js            # Ana bot kodu
proxy-lib.js      # Proxy çekme/doğrulama kütüphanesi
update-proxies.js # Proxy toplama aracı (node update-proxies.js)
package.json      # Bağımlılıklar ve komutlar
```
