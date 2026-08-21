# Content Scheduler (Cloud)

Generator brief/konten terjadwal yang berjalan di **GitHub Actions** — PC tidak
perlu menyala. Menjadwalkan prompt per-template (cron, zona Asia/Jakarta),
memanggil DeepSeek API, lalu menyimpan hasilnya sebagai markdown yang di-commit
ke repo ini.

## Cara kerja

1. GitHub Actions menjalankan workflow ini tiap jam (lihat .github/workflows/schedule.yml).
2. src/run.js membaca config.json (template + jadwal cron + prompt).
3. Untuk template yang waktunya tiba, run.js memanggil DeepSeek API.
4. Hasil ditulis ke output/ dan state.json diperbarui, lalu di-commit otomatis.

## Setup (sekali)

1. Buat repo GitHub (public = unlimited menit Actions; private = 2000 menit/bulan).
2. Push isi folder ini ke repo:

       git init
       git add -A
       git commit -m "init content scheduler"
       git branch -M main
       git remote add origin https://github.com/OWNER/REPO.git
       git push -u origin main

3. Tambah secret DeepSeek key: repo -> Settings -> Secrets and variables -> Actions
   -> New repository secret, nama DEEPSEEK_API_KEY, isi key dari
   https://platform.deepseek.com/api_keys
4. Aktifkan Actions jika diminta (tab Actions -> enable workflows).

## Uji coba

- Trigger manual: tab Actions -> "Scheduled Content" -> Run workflow.
- Lihat hasil: folder output/ setelah run selesai.
- Edit jadwal/prompt: ubah config.json lalu commit (push).

## Menambah / mengedit template

Setiap entri di templates berisi:

- id           : identitas unik
- enabled      : true / false
- cron         : 5 field (menit jam hari bulan hari-minggu), zona Asia/Jakarta
- title        : judul heading output
- systemPrompt : peran model
- prompt       : instruksi konten
- temperature  : 0 (deterministik) s/d 1 (kreatif)
- outputFile   : path relatif ke output/, dukung {date}, {time}, {datetime}, {id}

Contoh cron:

    0 7 * * 1    -> setiap Senin 07:00 WIB
    0 8 * * 3    -> setiap Rabu 08:00 WIB
    0 7 * * *    -> setiap hari 07:00 WIB

## Catatan

- state.json dan output/ sengaja TIDAK di-gitignore agar hasil & status jadwal
  ter-commit ke repo.
- Jika run terlewat (mis. GitHub delay), run.js "mengejar" sekali lalu lanjut.
- Integrasi DSH: pakai plugin @plnnr/dsh-scheduled-content (lihat repo dsh-ecosystem).
