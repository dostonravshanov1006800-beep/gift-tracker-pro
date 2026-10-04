# RUNBOOK

## Проверка здоровья (1 минута)
1. Открыть Actions этого репо: «Synthetic Monitor» зелёный? → сайт, зеркало и данные живы.
2. Красный монитор → посмотреть, какой шаг упал:
   - index != 200 → перезапустить «Deploy Pages» (Run workflow).
   - BROKEN img → перезапустить «Mirror Sync»; он дольёт битые.
   - live.json age > 900s → движок-источник молчит (см. Actions репо jethubvideo-code/gifttracker-bot, воркфлоу Gift Monitor Full / Guardian — там свой самоподъём).

## Ротация/переезд
- Весь сайт — статика в docs/; перенос: push в другой репо + включить Pages (Settings → Pages → Source: GitHub Actions) + секреты не нужны (токенов нет).
- Данные: сырой источник задан в docs/index.html (константы RAW/JSD/GHK, base64).

## Что где
- docs/index.html — одностраничник (рендер, поллинг, фолбэки).
- docs/img/*.webp — зеркало картинок (immutable, пополняет только Mirror Sync).
- sync.py — конвейер картинок (WebP, ≤10КБ, 3 канала источника).
