"""Pick the distinct screens of a video and tile them 2x2 into contact sheets.
Usage: frames.py VIDEO OUTDIR MAX  ->  OUTDIR/sheet0.jpg ...; prints how many distinct frames were kept."""
import sys

import av
from PIL import Image, ImageChops

src, outdir, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])
CELL = 768  # longest side of each frame: readable screen-recording text; a 2x2 sheet stays under the 1568px the model sees unscaled

def tiny(img):
    return img.convert("L").resize((16, 16))

def changed(a, b):  # mean pixel difference of 16x16 greyscale copies; catches cuts and new screens, ignores a talking head
    return sum(ImageChops.difference(a, b).getdata()) / 256 > 12

kept, last, next_t = [], None, 0.0
with av.open(src) as c:
    for frame in c.decode(video=0):
        if frame.time is None or frame.time < next_t:
            continue
        next_t = frame.time + 1  # sample about one frame per second
        img = frame.to_image()
        t = tiny(img)
        if last is None or changed(t, last):
            img.thumbnail((CELL, CELL))
            kept.append(img)
            last = t

if len(kept) > cap:  # too many distinct screens: keep an even spread of them
    kept = [kept[round(i * (len(kept) - 1) / (cap - 1))] for i in range(cap)]

for s in range(0, len(kept), 4):
    group = kept[s:s + 4]
    w, h = max(i.width for i in group), max(i.height for i in group)
    sheet = Image.new("RGB", (w * 2 if len(group) > 1 else w, h * 2 if len(group) > 2 else h), "white")
    for k, img in enumerate(group):
        sheet.paste(img, ((k % 2) * w, (k // 2) * h))
    sheet.save(f"{outdir}/sheet{s // 4}.jpg", quality=80)
print(len(kept))
