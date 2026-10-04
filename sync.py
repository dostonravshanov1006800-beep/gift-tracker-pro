# §6.1 PRO: источник → WebP ≤256px ≤10КБ → docs/img/<slug>.webp (immutable).
# Каналы: images.json источника (telesco.pe, ссылки истекают) → старое зеркало
# (публичные проверенные копии) → fragment.com (официальный CDN Telegram).
# Уже скачанное не трогаем; при нуле новых — выход без коммита.
import json, os, io, sys, time, urllib.request
from PIL import Image
SRC = os.environ.get('SRC', 'https://raw.githubusercontent.com/jethubvideo-code/gifttracker-bot/main/docs/images.json')
OLD_MIRROR = 'https://jethubvideo-code.github.io/gifttracker-img/img/'
FRAG = 'https://fragment.com/file/gifts/%s/thumb.webp'
def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; gm-mirror)'})
    return urllib.request.urlopen(req, timeout=timeout).read()
def save_webp(data, dst):
    im = Image.open(io.BytesIO(data)).convert('RGBA')
    if max(im.size) > 256:
        sc = 256 / max(im.size)
        im = im.resize((max(1, int(im.size[0]*sc)), max(1, int(im.size[1]*sc))), Image.LANCZOS)
    for q in (85, 80, 75, 60):
        im.save(dst, 'WEBP', quality=q, method=6)
        if os.path.getsize(dst) <= 10*1024: break
data = json.loads(fetch(SRC).decode())
imgs = data.get('images') or {}
os.makedirs('docs/img', exist_ok=True)
added, dead = [], []
for slug, url in imgs.items():
    if not url: continue
    dst = 'docs/img/%s.webp' % slug
    if os.path.exists(dst) and os.path.getsize(dst) > 0: continue  # immutable
    done = False
    for src in ('telesco', 'old', 'frag'):
        try:
            if src == 'telesco': b = fetch(url)
            elif src == 'old': b = fetch(OLD_MIRROR + slug + '.webp')
            else:
                save_webp(fetch(FRAG % slug.lower()), dst); done = True; break
            if src == 'telesco': save_webp(b, dst)
            else: open(dst, 'wb').write(b)
            done = True; break
        except Exception:
            time.sleep(1)
    if done: added.append(slug)
    else: dead.append(slug)
manifest = {f[:-5]: 'img/%s.webp' % f[:-5] for f in os.listdir('docs/img')}
with open('docs/images.json', 'w') as f:
    json.dump({'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'images': manifest, 'failed': dead}, f, ensure_ascii=False, indent=1)
print('mirror: %d total, +%d new, %d dead: %s' % (len(manifest), len(added), len(dead), dead[:5]))
