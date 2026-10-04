# Gift Tracker Pro

Трекер улучшенных NFT-подарков Telegram: 121 коллекция, живые данные, свои картинки.
- Сайт: https://dostonravshanov1006800-beep.github.io/gift-tracker-pro/
- Данные читает живьём из raw-CDN репозитория-источника (не дублирует движок).
- Картинки: своё зеркало `img/` (тот же origin), WebP ≤256px ≤10КБ, фолбэк chain.
- `sync.py` + workflow «Mirror Sync» держат зеркало полным (telesco → старое зеркало → fragment).
- «Synthetic Monitor» каждые 30 мин проверяет сайт/зеркало/свежесть — красный прогон = сбой.
Подробности: RUNBOOK.md, docs/baseline.md.
