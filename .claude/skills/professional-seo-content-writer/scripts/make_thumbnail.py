#!/usr/bin/env python3
"""
Fallback blog thumbnail renderer (Pillow only, no browser, no SVG).

Use this when Node/Playwright is not available (for example inside claude.ai
code execution). It draws the "bold" design: layered gradient, soft glows,
rings, dot grid, frosted cards with shadows, a tag pill, an auto-fitted
headline with an accented keyword, and film grain. It renders at 2x and
downsamples to exactly 768x401, then saves WebP.

Usage:
  python make_thumbnail.py --keyword "how to clean airpods" [--out file.webp]
         [--palette midnight|sunset|ocean|forest|ember|royal]
         [--tag "How-To Guide"] [--brand "MySite"] [--highlight "airpods"]
Requires: pip install pillow
"""
import argparse
import os
import random
import re
import sys
import zlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H, S = 768, 401, 2  # final size and supersampling factor
PALETTES = {
    "midnight": dict(bg=["#0b1026", "#1d2b6b", "#5b2bd6"], glow=["#7c5cff", "#22d3ee"], accent="#ffd23f", sub="#c9d1ff"),
    "sunset": dict(bg=["#2a0b3d", "#a3135f", "#ff6a3d"], glow=["#ff9a3d", "#ff3d8b"], accent="#ffe066", sub="#ffd9e6"),
    "ocean": dict(bg=["#03203a", "#055a7a", "#0fb5b5"], glow=["#2ee6d6", "#3d8bff"], accent="#ffd166", sub="#c8f3f3"),
    "forest": dict(bg=["#06241b", "#0d5c43", "#3aa66b"], glow=["#7be495", "#d4f36b"], accent="#f9d65c", sub="#d3f5df"),
    "ember": dict(bg=["#140a07", "#4a1508", "#d9480f"], glow=["#ff7b2e", "#ffb703"], accent="#ffd60a", sub="#ffe1cc"),
    "royal": dict(bg=["#120c2e", "#3b1c7a", "#b5179e"], glow=["#f72585", "#7209b7"], accent="#4cc9f0", sub="#e6d7ff"),
}
SMALL = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "via", "with", "from"}
ACRONYMS = {"seo", "ai", "ppc", "ui", "ux", "api", "cms", "crm", "roi", "kpi", "pdf", "url", "vpn", "ios", "pc", "tv",
            "diy", "faq", "usa", "uk", "eu", "html", "css", "gpt", "llm", "saas", "b2b", "b2c", "cpu", "gpu", "ssd",
            "ram", "usb", "hdmi", "wifi", "nft", "etf", "ira", "gst", "vat", "bmi", "dna", "hr", "qa"}
SPECIAL = {"airpods": "AirPods", "iphone": "iPhone", "ipad": "iPad", "macbook": "MacBook", "youtube": "YouTube",
           "tiktok": "TikTok", "linkedin": "LinkedIn", "chatgpt": "ChatGPT", "wordpress": "WordPress",
           "javascript": "JavaScript", "playstation": "PlayStation", "ebay": "eBay", "paypal": "PayPal",
           "github": "GitHub", "woocommerce": "WooCommerce"}

BOLD_FONTS = [
    # Windows
    r"C:\Windows\Fonts\seguibl.ttf", r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Arial Black.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    # Linux
    "/usr/share/fonts/truetype/inter/Inter-ExtraBold.ttf", "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]
SEMI_FONTS = [
    r"C:\Windows\Fonts\seguisb.ttf", r"C:\Windows\Fonts\arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/inter/Inter-SemiBold.ttf", "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def find_font(cands, size):
    for c in cands:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    try:  # fontconfig lookup on Linux
        import subprocess
        p = subprocess.run(["fc-match", "-f", "%{file}", "sans:bold"], capture_output=True, text=True).stdout
        if p and os.path.exists(p):
            return ImageFont.truetype(p, size)
    except Exception:
        pass
    return ImageFont.load_default(size)


def hexc(h, a=255):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (a,)


def title_case(s):
    s = s.strip()
    if re.search(r"[A-Z]", s):
        return s

    def cap(w, first, hy):
        bare = re.sub(r"[^a-z0-9]", "", w)
        if bare in SPECIAL:
            return w.replace(bare, SPECIAL[bare])
        if bare in ACRONYMS:
            return w.upper()
        if not first and not hy and w in SMALL:
            return w
        return w[:1].upper() + w[1:]

    out = []
    for i, w in enumerate(s.split()):
        parts = w.split("-")
        out.append("-".join(cap(p, i == 0 and j == 0, len(parts) > 1) for j, p in enumerate(parts)))
    return " ".join(out)


def guess_tag(k):
    s = k.lower()
    if re.match(r"^how (to|do|can)", s): return "How-To Guide"
    if re.match(r"^(what|why|when|who|which|is|are|can|does)\b", s): return "Explained"
    if re.search(r"\b(best|top)\b", s): return "Top Picks"
    if re.search(r"\bvs\.?\b|\bversus\b", s): return "Comparison"
    if re.search(r"\breview\b", s): return "Review"
    if re.search(r"\b(ideas|tips|examples|ways)\b", s): return "Ideas & Tips"
    return "Complete Guide"


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "thumbnail"


def gradient(w, h, stops):
    """Diagonal 3-stop gradient (computed small, then smoothly upscaled)."""
    sw, sh = max(2, w // 8), max(2, h // 8)
    base = Image.new("RGBA", (sw, sh))
    px = base.load()
    c = [hexc(x) for x in stops]
    for y in range(sh):
        for x in range(sw):
            t = (x / sw * 0.65 + y / sh * 0.35)
            if t < 0.55:
                u, a, b = t / 0.55, c[0], c[1]
            else:
                u, a, b = (t - 0.55) / 0.45, c[1], c[2]
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * u) for i in range(3)) + (255,)
    return base.resize((w, h), Image.BICUBIC)


def glow(canvas, box, color, alpha, blur):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=hexc(color, alpha))
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def rounded_card(canvas, xy, size, angle, fill, outline, radius, shadow=True):
    w, h = size
    pad = 80 * S
    card = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    if shadow:
        sh = Image.new("RGBA", card.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([pad, pad + 26 * S, pad + w, pad + h + 26 * S], radius, fill=(0, 0, 0, 110))
        card.alpha_composite(sh.filter(ImageFilter.GaussianBlur(22 * S)))
    d.rounded_rectangle([pad, pad, pad + w, pad + h], radius, fill=fill, outline=outline, width=2 * S)
    return card, pad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--out")
    ap.add_argument("--palette")
    ap.add_argument("--tag")
    ap.add_argument("--brand")
    ap.add_argument("--highlight")
    ap.add_argument("--quality", type=int, default=92)
    a = ap.parse_args()

    names = list(PALETTES)
    pname = a.palette if a.palette in PALETTES else names[zlib.crc32(a.keyword.encode()) % len(names)]
    P = PALETTES[pname]
    title = title_case(a.keyword)
    tag = (a.tag or guess_tag(a.keyword)).upper()
    out = a.out or slugify(a.keyword) + ".webp"
    w, h = W * S, H * S

    img = gradient(w, h, P["bg"])
    glow(img, [w - 260 * S, -120 * S, w + 80 * S, 220 * S], P["glow"][0], 200, 60 * S)
    glow(img, [w - 430 * S, h - 110 * S, w - 170 * S, h + 150 * S], P["glow"][1], 140, 70 * S)
    d = ImageDraw.Draw(img)

    # rings
    ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.ellipse([w - 250 * S, h - 190 * S, w + 170 * S, h + 230 * S], outline=(255, 255, 255, 46), width=int(1.5 * S))
    rd.ellipse([w - 190 * S, h - 130 * S, w + 110 * S, h + 170 * S], outline=(255, 255, 255, 34), width=int(1.5 * S))
    img.alpha_composite(ring)
    # dot grid fading right
    dots = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for gx in range(11):
        for gy in range(7):
            a_ = int(80 * (1 - gx / 11))
            cx, cy = (28 + gx * 14) * S, (H - 116 + gy * 14) * S
            dd.ellipse([cx - 1.4 * S, cy - 1.4 * S, cx + 1.4 * S, cy + 1.4 * S], fill=(255, 255, 255, a_))
    img.alpha_composite(dots)

    # frosted cards
    stage_x, stage_y = (W - 34 - 250) * S, int((H - 290) / 2) * S
    back, pad = rounded_card(img, None, (200 * S, 240 * S), 7, (255, 255, 255, 40), (255, 255, 255, 70), 20 * S)
    back = back.rotate(-7, resample=Image.BICUBIC, expand=False)
    img.alpha_composite(back, (stage_x + 50 * S - pad, stage_y + 10 * S - pad))
    front, pad = rounded_card(img, None, (210 * S, 250 * S), -5, (255, 255, 255, 52), (255, 255, 255, 80), 20 * S)
    fd = ImageDraw.Draw(front)
    hero = gradient(170 * S, 96 * S, [P["glow"][0], P["glow"][0], P["glow"][1]])
    m = Image.new("L", hero.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, hero.size[0], hero.size[1]], 12 * S, fill=255)
    hd = ImageDraw.Draw(hero)
    hd.ellipse([16 * S, 16 * S, 60 * S, 60 * S], fill=(255, 255, 255, 100))
    hd.ellipse([110 * S, 50 * S, 200 * S, 140 * S], fill=(255, 255, 255, 70))
    hero.putalpha(ImageChops.multiply(hero.getchannel("A"), m))
    front.alpha_composite(hero, (pad + 20 * S, pad + 22 * S))
    for i, (wd, al) in enumerate([(0.85, 140), (1, 70), (0.7, 70), (0.88, 70)]):
        y = pad + (22 + 96 + 14 + i * 18) * S
        fd.rounded_rectangle([pad + 20 * S, y, pad + 20 * S + int(170 * S * wd), y + 9 * S], 5 * S, fill=(255, 255, 255, al))
    front = front.rotate(5, resample=Image.BICUBIC, expand=False)
    img.alpha_composite(front, (stage_x - pad, stage_y + 28 * S - pad))

    # chip
    chip_txt = "Step by step" if tag.startswith("HOW") else ("Tested picks" if tag == "TOP PICKS" else "Expert tips")
    cf = find_font(BOLD_FONTS, 13 * S)
    cw = int(d.textlength("★ " + chip_txt, font=cf)) + 28 * S
    chip = Image.new("RGBA", (cw + 60 * S, 34 * S + 60 * S), (0, 0, 0, 0))
    cd = ImageDraw.Draw(chip)
    cd.rounded_rectangle([30 * S, 30 * S, 30 * S + cw, 30 * S + 34 * S], 14 * S, fill=hexc(P["accent"]))
    cd.text((30 * S + 14 * S, 30 * S + 17 * S), "★ " + chip_txt, font=cf, fill=(17, 17, 17, 255), anchor="lm")
    chip = chip.rotate(4, resample=Image.BICUBIC)
    img.alpha_composite(chip, (stage_x - 26 * S - 30 * S, stage_y + (290 - 16 - 34) * S - 30 * S))

    # text block
    left, box_w = 48 * S, 418 * S
    words = title.split()
    hl = (a.highlight or words[-1]).lower().split()
    start = len(words) - 1
    for i in range(len(words) - len(hl) + 1):
        if [re.sub(r"\W", "", x.lower()) for x in words[i:i + len(hl)]] == [re.sub(r"\W", "", x) for x in hl]:
            start = i
    hl_idx = set(range(start, start + len(hl))) if start != len(words) - 1 or len(hl) == 1 else {len(words) - 1}

    tf = find_font(SEMI_FONTS, 12 * S)
    bf = find_font(SEMI_FONTS, 14 * S)
    extra_h = (30 + 18 + 5 + 18 + (26 + 18 if a.brand else 0)) * S
    max_h = (H - 90) * S - extra_h

    def layout(size):
        f = find_font(BOLD_FONTS, size * S)
        lines, cur = [], []
        for i, wd in enumerate(words):
            trial = cur + [(i, wd)]
            if cur and d.textlength(" ".join(x for _, x in trial), font=f) > box_w:
                lines.append(cur)
                cur = [(i, wd)]
            else:
                cur = trial
        lines.append(cur)
        too_wide = any(d.textlength(" ".join(x for _, x in ln), font=f) > box_w for ln in lines)
        return f, lines, too_wide

    for size in range(62, 23, -1):
        f, lines, too_wide = layout(size)
        lh = int(size * 1.08 * S)
        if not too_wide and len(lines) <= 3 and lh * len(lines) <= max_h:
            break

    total_h = 30 * S + 18 * S + lh * len(lines) + 18 * S + 5 * S + ((18 + 26) * S if a.brand else 0)
    y = (h - total_h) // 2

    # tag pill
    tw = int(d.textlength(tag, font=tf)) + int(1.4 * S * len(tag))
    pill = [left, y, left + tw + 40 * S, y + 30 * S]
    pl = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(pl).rounded_rectangle(pill, 15 * S, fill=(255, 255, 255, 30), outline=(255, 255, 255, 60), width=S)
    img.alpha_composite(pl)
    d.ellipse([left + 12 * S, y + 11 * S, left + 20 * S, y + 19 * S], fill=hexc(P["accent"]))
    x = left + 28 * S
    for ch in tag:  # letter-spaced
        d.text((x, y + 15 * S), ch, font=tf, fill=(255, 255, 255, 255), anchor="lm")
        x += d.textlength(ch, font=tf) + 1.4 * S
    y += 30 * S + 18 * S

    # headline with soft shadow
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for li, ln in enumerate(lines):
        x = left
        for i, wd in ln:
            sd.text((x, y + li * lh + 2 * S), wd, font=f, fill=(0, 0, 0, 90))
            x += d.textlength(wd + " ", font=f)
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12 * S)))
    d = ImageDraw.Draw(img)
    for li, ln in enumerate(lines):
        x = left
        for i, wd in ln:
            d.text((x, y + li * lh), wd, font=f, fill=hexc(P["accent"]) if i in hl_idx else (255, 255, 255, 255))
            x += d.textlength(wd + " ", font=f)
    y += lh * len(lines) + 18 * S

    # accent bar
    bar = gradient(64 * S, 5 * S, [P["accent"], P["accent"], P["glow"][0]])
    bm = Image.new("L", bar.size, 0)
    ImageDraw.Draw(bm).rounded_rectangle([0, 0, bar.size[0], bar.size[1]], 3 * S, fill=255)
    bar.putalpha(bm)
    img.alpha_composite(bar, (left, y))
    y += 5 * S + 18 * S

    if a.brand:
        d.rounded_rectangle([left, y, left + 26 * S, y + 26 * S], 8 * S, fill=hexc(P["accent"]))
        d.text((left + 13 * S, y + 13 * S), a.brand[0].upper(), font=find_font(BOLD_FONTS, 14 * S), fill=(17, 17, 17, 255), anchor="mm")
        d.text((left + 35 * S, y + 13 * S), a.brand, font=bf, fill=hexc(P["sub"]), anchor="lm")

    # film grain
    rnd = random.Random(1)
    noise = Image.frombytes("L", (w // 2, h // 2), bytes(rnd.randrange(256) for _ in range((w // 2) * (h // 2)))).resize((w, h))
    grain = Image.merge("RGBA", (noise, noise, noise, Image.new("L", (w, h), 22)))
    img.alpha_composite(grain)

    final = img.convert("RGB").resize((W, H), Image.LANCZOS)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    final.save(out, "WEBP", quality=a.quality, method=6)
    print({"file": os.path.abspath(out), "width": W, "height": H, "palette": pname, "headline": title})


if __name__ == "__main__":
    sys.exit(main())
