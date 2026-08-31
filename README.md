# Agent Mission Control

Claude Code agent ekiplerini canlı izleme ve yönetme paneli. İki parçadan oluşur:

1. **Web panel** (`index.html` + `config.js`) — Vercel'de statik olarak barınır.
   Veriyi Supabase'den token doğrulamalı RPC'lerle okur; görev verme, agent
   ekleme/çıkarma komutlarını Supabase kuyruğuna yazar. İlk açılışta panel
   erişim tokenı sorar (tarayıcıda saklanır).
2. **Yerel toplayıcı** (`local/collector.js`) — Mac'te çalışır.
   `~/.claude/teams`, `~/.claude/tasks` ve transcript dosyalarını okuyup 3
   saniyede bir Supabase'e iter; webden gelen komutları çekip
   `~/agent-mission-control/task-queue.md` kuyruğuna ve `agents.json`'a uygular.
   Aynı zamanda http://localhost:5757 üzerinde panelin yerel kopyasını sunar
   (yerel mod Supabase'e ihtiyaç duymaz).

## Kurulum

```bash
# Supabase şemasını uygula (bir kez): supabase/migration.sql
# panel_secrets tablosuna bir token ekle.

# Repo kökünde .env oluştur (gitignore'da):
# SUPABASE_URL=https://XXX.supabase.co
# SUPABASE_ANON_KEY=...
# PANEL_TOKEN=...

node local/collector.js
```

`config.js` web panelin Supabase adresini ve anon anahtarını içerir (anon
anahtar herkese açık olacak şekilde tasarlanmıştır; güvenlik RLS + token
doğrulayan fonksiyonlardadır).

Ekip lideri kuyruğu nasıl izler: lider oturumuna kickoff mesajında
`~/agent-mission-control/task-queue.md` dosyasını boşta kaldığında kontrol
etmesi söylenir; `- [ ]` satırlarını görev olarak alır, bitince `- [x]` yapar.
