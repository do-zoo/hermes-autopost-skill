# hermes-autopost-skill

Skill untuk **Hermes Agent** (Nous Research) yang merencanakan topik, menulis artikel, lalu mengirimnya sebagai **draft** ke backoffice Inget Gue lewat adapter `post-article.ts` milikmu. Jalan di VPS lewat cron bawaan Hermes.

```
cron Hermes (every 1h)
  └─ precheck (script, tanpa LLM)  → tidak ada kerja? {"wakeAgent": false}, selesai, 0 token
  └─ ada kerja → Hermes memuat skill autopost-article
        context → plan-add        (isi antrean topik)
        next → tulis draft → submit   (gerbang kualitas → post-article.ts → draft di backoffice)
```

Pembagian tugas: Hermes hanya **memilih topik dan menulis**. Semua yang berefek samping (planner, validasi, pemanggilan adapter, retry, status) ada di `autopost.mjs` yang deterministik. Draft di-publish manusia (ContentBot memang tidak bisa publish).

## Isi

| Path | Fungsi |
|---|---|
| `skill/autopost-article/` | Skill (SKILL.md, `scripts/autopost.mjs`, `references/`) |
| `hermes-scripts/autopost-precheck.sh` | Pre-check cron, dipasang ke `~/.hermes/scripts/` |
| `config/sites.example.json`, `config/cron-prompt.txt` | Contoh konfigurasi dan prompt cron |
| `install.sh` | Pasang ke profile; baca `config/install.conf` (git-ignored) |
| `config/install.conf.example` | Template pengaturan lokal (profile, token, jadwal) |
| `dev/` | Mock API + tes integrasi terhadap `post-article.ts` asli |

## Setup di VPS

1. **Pasang Hermes Agent** (ikuti dokumen resmi), pilih provider/model API-mu, dan jalankan `hermes` sekali untuk memastikan jalan.
2. **Token Inget Gue**: buat user `hermes` (role ContentBot), token di *Account → API Tokens*, scope minimal `posts:read` + `posts:create`.
3. **Pasang skill** ke profile khusus (disarankan; profile = `HERMES_HOME` terpisah, `~/.hermes/profiles/<profile>/`).
   Semua pengaturan lokal ada di file sendiri yang **di-ignore git** (`.gitignore` sudah disertakan):
   ```bash
   hermes profile create autopost                         # sekali saja, kalau belum ada
   cp config/install.conf.example config/install.conf     # PROFILE, INGET_HERMES_TOKEN, jadwal cron
   cp config/sites.example.json config/sites.json         # apiUrl, adapterDir, niche, bilingual, dll.
   ./install.sh                                           # tambah --force untuk menimpa, --cron untuk sekalian membuat job
   ```
   `install.sh` membaca `config/install.conf` (atau `--config FILE`); flag CLI menimpa isinya. Token ditulis langsung ke `$HERMES_HOME/.env` (chmod 600), tidak lewat argumen perintah dan tidak dicetak. `config/sites.json` disalin ke `$HERMES_HOME/autopost/sites.json`; bila tidak ada dan belum terpasang, contoh yang dipakai.
   Tanpa `--profile`, dipasang ke `~/.hermes` (profile default). Di bawah, `~/.hermes` berarti `$HERMES_HOME` profile-mu.
   `install.sh` menanam path `HERMES_HOME` absolut ke script precheck (env cron disanitasi) dan **menyalin** script, bukan symlink (path di luar `scripts/` ditolak Hermes). `autopost.mjs` menurunkan `HERMES_HOME` dari lokasinya sendiri bila env tidak diwariskan.

   **Konfigurasi profile yang disarankan** (`hermes -p autopost config edit`; semua per-profile):
   ```yaml
   memory: { memory_enabled: false, user_profile_enabled: false }   # planner = file JSON, bukan memory
   skills: { write_approval: true }          # agent tidak boleh menulis ulang skill-nya sendiri
   terminal: { cwd: /home/<user>/.hermes/profiles/autopost }        # path absolut; kosong = $HOME
   cron: { require_restart_safe_scope: true }
   approvals:
     deny: ["*INGET_HERMES_TOKEN*", "printenv*", "*cat *.env*"]     # dicek sebelum yolo
   ```
   Pin model cron (`cron.model` atau `--pin`) agar tidak ikut berubah saat model utama diganti. Matikan bawaan skill yang tak dipakai: `hermes -p autopost skills opt-out --remove`.
4. **Toolset** (`hermes tools`): untuk platform `cron` aktifkan hanya `terminal`, `file`, `skills`. Matikan `web`, `browser`, dan lainnya kalau tidak dibutuhkan (permukaan serangan lebih kecil; `research:false` memang melarang tautan).
5. **Tes manual** sebelum dijadwalkan:
   ```bash
   node ~/.hermes/skills/autopost-article/scripts/autopost.mjs status
   node ~/.hermes/skills/autopost-article/scripts/autopost.mjs context --site inget-gue
   hermes chat -q "Use the autopost-article skill for site inget-gue: plan topics, then write one article and submit it with --dry-run"
   ```
   `--dry-run` menulis `~/.hermes/autopost/out/<site>/<item>.json` (format yang dibaca `post-article.ts`), tidak mengirim, item tetap pending.
6. **Jadwalkan**:
   ```bash
   hermes -p autopost cron create "every 1h" "$(cat ~/.hermes/profiles/autopost/autopost/cron-prompt.txt)" \
     --script autopost-precheck.sh \
     --skill autopost-article --name autopost --deliver local
   loginctl enable-linger $USER      # supaya tetap jalan setelah logout
   hermes gateway install && hermes gateway start     # dari profile DEFAULT
   hermes gateway status             # baris "Serves:" harus memuat profile autopost
   hermes -p autopost cron status    # cek heartbeat tick
   ```
   Profile bernama tidak punya gateway sendiri (exit 78); gateway host milik profile default melayani semua profile aktif dan men-tick cron mereka. Bila job ter-kill di tengah kirim, kasus "already exists" yang ambigu (lihat bawah) jadi lebih mungkin, sebab itu `require_restart_safe_scope` dan linger penting.
   Interval 1 jam sengaja dipilih: jadwal sebenarnya ada di `scheduledFor` tiap item (`cadenceHours`, default 24), sehingga zona waktu cron tidak berpengaruh, dan precheck memastikan jam-jam kosong tidak memanggil LLM.

## Field `sites.json`

| Field | Default | Keterangan |
|---|---|---|
| `id`, `apiUrl` | wajib | Backend API (`INGET_API_URL`) |
| `adapterDir` | wajib | Folder `scripts/post-article` |
| `adapterCommand` | `["npx","tsx","post-article.ts"]` | Disarankan `["./node_modules/.bin/tsx","post-article.ts"]` |
| `apiKeyEnv` | `INGET_HERMES_TOKEN` | Nama env var token. Site tambahan: tambahkan nama var ke `terminal.env_passthrough` |
| `niche`, `audience`, `tone` | | Konteks penulisan; bedakan antar-site |
| `bilingual` | `false` | `true` = versi Inggris lengkap (backend menolak yang parsial) |
| `research` | `false` | `false` = semua tautan ditolak (URL pasti karangan) |
| `postsPerRun` | 1 | Artikel per bangun |
| `cadenceHours` | 24 | Jarak antar artikel terjadwal |
| `planBacklogTarget` / `planRefillBelow` | 14 / ½ target | Antrean diisi ulang bila di bawah `refillBelow`, sampai `target` |
| `minWords`, `maxAttempts` | 600, 3 | Gerbang panjang (EN × 0.7); batas revisi |

State ada di `~/.hermes/autopost/` (`plans/`, `drafts/`, `out/`), JSON biasa, aman diperiksa atau disunting saat tidak ada run berjalan. Planner di sisi web belum diimplementasikan; semua site memakai planner lokal ini.

## Perilaku hasil kirim

| Adapter | `submit` | Efek |
|---|---|---|
| 0 | exit 0 `published` | Draft ada di backoffice |
| 4 / timeout 120 dtk | exit 20 `deferred` | Item pending, +1 jam, percobaan tidak berkurang, draft dipertahankan (kirim ulang tanpa menulis ulang) |
| 1, 2 | exit 30 `blocked` | Item pending, +6 jam, agent diminta berhenti dan melapor (token/konfigurasi) |
| 3 "already exists" | exit 30 `failed` | Perlu cek manusia (bisa slug bentrok atau kiriman sebelumnya yang ternyata masuk) |
| 3 lainnya, atau gagal gerbang | exit 10 `revise` | Agent memperbaiki file draft yang sama; `maxAttempts` lalu `failed` |

Gerbang kualitas menolak: H1/H5/H6, tabel, HTML inline, gambar, tautan (bila `research:false`), placeholder, meta-komentar AI, `<think>`, kurang dari 2 H2, terlalu pendek. Alasannya: backend diam-diam membuang tag di luar `p br h2 h3 h4 strong em u s blockquote ul ol li a img hr code pre`.

## Keamanan

- Token tidak pernah dicetak; proses anak adapter hanya menerima `PATH`, `HOME`, `INGET_API_URL`, `INGET_API_TOKEN`.
- Hanya membuat draft; scope token minimal; kategori tidak pernah dibuat otomatis.
- `approvals.cron_mode` bawaan Hermes `deny` hanya berlaku untuk perintah berpola berbahaya (`bash -c`, `node -c`, heredoc, `curl | sh`). SKILL.md sudah mengarahkan agent memakai `write_file` dan `node ${HERMES_SKILL_DIR}/scripts/autopost.mjs ...` langsung. Bila perintah itu tetap diblokir, tambahkan polanya ke `command_allowlist`. Ini kebijakan, bukan sandbox: profile bukan batas keamanan, jadi token tetap scope minimal.
- Jangan jalankan dua proses agent pada satu profile.
- Tinjau draft terutama klaim faktual; prompt melarang mengarang angka/kutipan, tapi itu mengurangi, bukan menghilangkan, halusinasi.

## Tes

```bash
ADAPTER_DIR=/opt/inget-gue/scripts/post-article dev/test.sh
```
Menjalankan `autopost.mjs` terhadap `post-article.ts` asli dan mock API: precheck, dedupe/kategori, gerbang, publish bilingual, 500 → deferred → kirim ulang, "exists", token salah, dan dua `next` paralel. Status terakhir: 29/29 lulus.

## Belum terverifikasi (tidak bisa diuji tanpa Hermes + model sungguhan)

Terverifikasi lewat dokumentasi (belum dijalankan): `${HERMES_SKILL_DIR}`, `required_environment_variables` (auto-passthrough, `blocked_config` tanpa panggilan LLM), mekanisme `{"wakeAgent": false}`, format `terminal.env_passthrough`, perilaku `cron_mode`.

1. Apakah `cron create` menerima `--script` untuk job LLM (di dokumen hanya terlihat pada contoh `--no-agent`); cek `hermes cron create --help`.
2. Gateway host berjalan dan men-tick profile tanpa platform pesan satu pun.
3. `HERMES_HOME` ter-export ke child terminal (sudah ada fallback dari lokasi script).
4. Bagaimana output precheck (teks "Sites needing work") disuntikkan ke prompt agent.
5. Seberapa patuh model pilihanmu pada format front matter dan jumlah kata; jalankan dry-run beberapa kali dulu.
6. Dokumentasi tidak menyebut zona waktu cron; desain ini tidak bergantung padanya.

Kelemahan adapter yang masih ada (di luar paket ini): `fetch` tanpa timeout, "already exists" setelah retry POST ambigu, dedupe hanya 100 judul pertama.
