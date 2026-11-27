#!/usr/bin/env node
/*
 * Blog thumbnail renderer: designs a 768x401 WebP featured image for a blog
 * post from its main keyword. The design is built in HTML/CSS (real fonts,
 * gradients, glass, glows, film grain, optional photo), rendered to pixels in
 * headless Chromium at 2x, downsampled for crisp edges and encoded as WebP.
 * No SVG is used anywhere.
 *
 * Usage:
 *   node make-thumbnail.cjs --keyword "how to clean airpods" [options]
 *
 * Options:
 *   --keyword    Main keyword shown as the headline (required)
 *   --out        Output path (default: <keyword-slug>.webp)
 *   --style      bold | minimal | split | photo   (default: bold)
 *                split and photo need --photo
 *   --palette    midnight | sunset | ocean | forest | ember | royal | mint | coral
 *                (default: picked from the keyword)
 *   --tag        Small label above the headline, e.g. "Guide" (default: from keyword)
 *   --brand      Site name or domain shown in the footer (optional)
 *   --highlight  Word(s) of the headline to accent (default: last word)
 *   --photo      Path to a photo you own or may use (jpg/png/webp)
 *   --quality    WebP quality 0-1 (default: 0.92)
 *
 * Requires Node 18+ and Playwright with Chromium:
 *   npm i playwright && npx playwright install chromium
 */
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i playwright && npx playwright install chromium\n' +
    'Or use the Pillow fallback: python make_thumbnail.py --keyword "..."');
  process.exit(2);
}

const W = 768, H = 401;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k] = v;
  }
  return a;
}

const PALETTES = {
  midnight: { bg: ['#0b1026', '#1d2b6b', '#5b2bd6'], glow: ['#7c5cff', '#22d3ee'], accent: '#ffd23f', ink: '#ffffff', sub: '#c9d1ff' },
  sunset:   { bg: ['#2a0b3d', '#a3135f', '#ff6a3d'], glow: ['#ff9a3d', '#ff3d8b'], accent: '#ffe066', ink: '#ffffff', sub: '#ffd9e6' },
  ocean:    { bg: ['#03203a', '#055a7a', '#0fb5b5'], glow: ['#2ee6d6', '#3d8bff'], accent: '#ffd166', ink: '#ffffff', sub: '#c8f3f3' },
  forest:   { bg: ['#06241b', '#0d5c43', '#3aa66b'], glow: ['#7be495', '#d4f36b'], accent: '#f9d65c', ink: '#ffffff', sub: '#d3f5df' },
  ember:    { bg: ['#140a07', '#4a1508', '#d9480f'], glow: ['#ff7b2e', '#ffb703'], accent: '#ffd60a', ink: '#ffffff', sub: '#ffe1cc' },
  royal:    { bg: ['#120c2e', '#3b1c7a', '#b5179e'], glow: ['#f72585', '#7209b7'], accent: '#4cc9f0', ink: '#ffffff', sub: '#e6d7ff' },
  mint:     { bg: ['#eafff6', '#c6f7e2', '#8ee6c4'], glow: ['#50d6a0', '#a0f0ff'], accent: '#0a7d5a', ink: '#0b2b22', sub: '#2d5c4e' },
  coral:    { bg: ['#fff1eb', '#ffd3c4', '#ffab91'], glow: ['#ff7a59', '#ffc6a8'], accent: '#d9381e', ink: '#2b0f08', sub: '#6b3527' },
};

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with', 'from']);
const ACRONYMS = new Set(['seo', 'ai', 'ppc', 'ui', 'ux', 'api', 'cms', 'crm', 'roi', 'kpi', 'pdf', 'url', 'vpn', 'ios', 'pc', 'tv', 'diy', 'faq', 'usa', 'uk', 'eu', 'us', 'html', 'css', 'gpt', 'llm', 'saas', 'b2b', 'b2c', 'cpu', 'gpu', 'ssd', 'ram', 'usb', 'hdmi', 'wifi', 'nft', 'etf', 'ira', 'gst', 'vat', 'bmi', 'dna', 'hr', 'it', 'qa']);
const SPECIAL = { airpods: 'AirPods', iphone: 'iPhone', ipad: 'iPad', macbook: 'MacBook', youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn', chatgpt: 'ChatGPT', wordpress: 'WordPress', javascript: 'JavaScript', playstation: 'PlayStation', ebay: 'eBay', paypal: 'PayPal', github: 'GitHub', woocommerce: 'WooCommerce' };
function titleCase(s) {
  if (/[A-Z]/.test(s)) return s.trim(); // respect casing the user gave
  const cap = (w, first, hyphenated) => {
    const bare = w.replace(/[^a-z0-9]/g, '');
    if (SPECIAL[bare]) return w.replace(bare, SPECIAL[bare]);
    if (ACRONYMS.has(bare) && bare !== 'it' && bare !== 'us') return w.toUpperCase();
    if (!first && !hyphenated && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  return s.trim().split(/\s+/).map((w, i) => w.split('-').map((p, j, all) => cap(p, i === 0 && j === 0, all.length > 1)).join('-')).join(' ');
}
function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'thumbnail';
}
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function guessTag(k) {
  const s = k.toLowerCase();
  if (/^how (to|do|can)/.test(s)) return 'How-To Guide';
  if (/^(what|why|when|who|which|is|are|can|does)\b/.test(s)) return 'Explained';
  if (/\b(best|top)\b/.test(s)) return 'Top Picks';
  if (/\bvs\.?\b|\bversus\b/.test(s)) return 'Comparison';
  if (/\breview\b/.test(s)) return 'Review';
  if (/\b(ideas|tips|examples|ways)\b/.test(s)) return 'Ideas & Tips';
  return 'Complete Guide';
}

function headlineHTML(title, highlight) {
  const words = title.split(/\s+/);
  const hl = (highlight ? highlight.toLowerCase().split(/\s+/) : [words[words.length - 1].toLowerCase()]);
  // find the highlight sequence in the title; fall back to last word
  let start = -1;
  for (let i = 0; i + hl.length <= words.length; i++) {
    if (hl.every((w, j) => words[i + j].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === w.replace(/[^\p{L}\p{N}]/gu, ''))) start = i;
  }
  if (start < 0) { start = words.length - 1; hl.length = 1; }
  return words.map((w, i) => {
    const e = esc(w);
    if (i === start && hl.length === 1) return `<span class="hl">${e}</span>`;
    if (i === start) return `<span class="hl">${e}`;
    if (i === start + hl.length - 1) return `${e}</span>`;
    return e;
  }).join(' ');
}

function photoURI(p) {
  if (!p) return '';
  const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${fs.readFileSync(p).toString('base64')}`;
}

function buildHTML(o) {
  const P = o.pal;
  const dark = !['mint', 'coral'].includes(o.paletteName);
  const fonts = o.style === 'minimal'
    ? 'family=Playfair+Display:wght@700;800;900&family=Inter:wght@500;600;700'
    : 'family=Poppins:wght@600;700;800;900&family=Inter:wght@500;600;700';
  const display = o.style === 'minimal' ? "'Playfair Display', Georgia, 'Times New Roman', serif"
    : "'Poppins', 'Inter Display', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  const brand = o.brand ? `<div class="brand"><span class="logo">${esc(o.brand.charAt(0).toUpperCase())}</span>${esc(o.brand)}</div>` : '';

  const css = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  body{font-family:'Inter','Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .c{position:relative;width:${W}px;height:${H}px;overflow:hidden}
  .grain{position:absolute;inset:0;background-size:160px;mix-blend-mode:overlay;opacity:${dark ? .16 : .22};pointer-events:none;z-index:50}
  .tag{display:inline-flex;align-items:center;gap:8px;padding:7px 14px 7px 11px;border-radius:999px;font:700 12px/1 'Inter',Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase}
  .tag i{width:8px;height:8px;border-radius:50%;background:${P.accent};box-shadow:0 0 10px ${P.accent}}
  .title{font-family:${display};font-weight:800;letter-spacing:-.02em;line-height:1.06}
  .brand{display:flex;align-items:center;gap:9px;font:600 14px/1 'Inter',Arial,sans-serif;letter-spacing:.01em}
  .logo{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;font:800 14px/1 'Inter',Arial,sans-serif}
  `;

  let body = '';
  if (o.style === 'bold') {
    body = `
    <style>
      .c{background:
        radial-gradient(120% 140% at 0% 0%, ${P.bg[0]} 0%, transparent 55%),
        radial-gradient(90% 120% at 100% 100%, ${P.bg[2]} 0%, transparent 60%),
        linear-gradient(135deg, ${P.bg[0]} 0%, ${P.bg[1]} 55%, ${P.bg[2]} 100%)}
      .blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.75}
      .b1{width:340px;height:340px;right:-60px;top:-120px;background:${P.glow[0]}}
      .b2{width:260px;height:260px;right:170px;bottom:-150px;background:${P.glow[1]};opacity:.55}
      .dots{position:absolute;left:28px;bottom:26px;width:150px;height:90px;
        background-image:radial-gradient(${dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.22)'} 1.4px, transparent 1.6px);background-size:14px 14px;
        -webkit-mask-image:linear-gradient(90deg,#000,transparent);opacity:.8}
      .ring{position:absolute;border-radius:50%;border:1.5px solid ${dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)'}}
      .r1{width:420px;height:420px;right:-170px;bottom:-230px}
      .r2{width:300px;height:300px;right:-110px;bottom:-170px;border-style:dashed}
      .stage{position:absolute;right:34px;top:50%;width:250px;height:290px;transform:translateY(-50%)}
      .card{position:absolute;border-radius:20px;background:${dark ? 'linear-gradient(160deg,rgba(255,255,255,.24),rgba(255,255,255,.06))' : 'linear-gradient(160deg,rgba(255,255,255,.85),rgba(255,255,255,.45))'};
        border:1px solid ${dark ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.9)'};backdrop-filter:blur(14px);
        box-shadow:0 30px 60px -20px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.35)}
      .k1{width:200px;height:240px;right:0;top:10px;transform:rotate(7deg)}
      .k2{width:210px;height:250px;left:0;top:28px;transform:rotate(-5deg);padding:22px 20px}
      .k2 .hero{height:96px;border-radius:12px;background:linear-gradient(135deg,${P.glow[0]},${P.glow[1]});position:relative;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
      .k2 .hero:after{content:'';position:absolute;width:90px;height:90px;border-radius:50%;right:-20px;bottom:-34px;background:rgba(255,255,255,.28)}
      .k2 .hero:before{content:'';position:absolute;width:44px;height:44px;border-radius:50%;left:16px;top:16px;background:rgba(255,255,255,.4)}
      .ln{height:9px;border-radius:9px;background:${dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.18)'};margin-top:14px}
      .ln.s{background:${dark ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.1)'};margin-top:9px}
      .chip{position:absolute;left:-26px;bottom:16px;padding:10px 14px;border-radius:14px;background:${P.accent};color:${dark ? '#111' : '#fff'};
        font:800 13px/1 'Inter',Arial,sans-serif;box-shadow:0 14px 30px -10px rgba(0,0,0,.5);transform:rotate(-4deg)}
      .copy{position:absolute;left:48px;top:46px;bottom:44px;width:418px;display:flex;flex-direction:column;justify-content:center;gap:18px;z-index:5}
      .tag{align-self:flex-start;color:${P.ink};background:${dark ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.7)'};border:1px solid ${dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.08)'};backdrop-filter:blur(6px)}
      .title{color:${P.ink};text-shadow:${dark ? '0 2px 24px rgba(0,0,0,.25)' : 'none'}}
      .hl{color:${P.accent};position:relative;white-space:nowrap}
      .bar{width:64px;height:5px;border-radius:5px;background:linear-gradient(90deg,${P.accent},${P.glow[0]})}
      .brand{color:${P.sub}} .logo{background:${P.accent};color:${dark ? '#111' : '#fff'}}
    </style>
    <div class="c">
      <div class="blob b1"></div><div class="blob b2"></div>
      <div class="ring r1"></div><div class="ring r2"></div><div class="dots"></div>
      <div class="stage">
        <div class="card k1"></div>
        <div class="card k2"><div class="hero"></div><div class="ln" style="width:85%"></div><div class="ln s" style="width:100%"></div><div class="ln s" style="width:70%"></div><div class="ln s" style="width:88%"></div></div>
        <div class="chip">★ ${esc(o.chip)}</div>
      </div>
      <div class="copy">
        <div class="tag"><i></i>${esc(o.tag)}</div>
        <h1 class="title fit">${o.headline}</h1>
        <div class="bar"></div>
        ${brand}
      </div>
      <div class="grain"></div>
    </div>`;
  } else if (o.style === 'minimal') {
    const paper = dark ? '#f7f2e9' : P.bg[0];
    body = `
    <style>
      .c{background:radial-gradient(120% 120% at 100% 0%, ${P.glow[0]}33 0%, transparent 50%), ${paper}}
      .frame{position:absolute;inset:16px;border:1.5px solid ${dark ? P.bg[1] : P.ink}22;border-radius:6px}
      .corner{position:absolute;width:150px;height:150px;border-radius:50%;right:-40px;top:-40px;background:${dark ? P.bg[2] : P.accent};opacity:.95}
      .corner2{position:absolute;width:70px;height:70px;border-radius:50%;right:100px;top:74px;background:${P.accent};mix-blend-mode:multiply;opacity:.85}
      .mdots{position:absolute;right:44px;bottom:42px;width:120px;height:120px;background-image:radial-gradient(${dark ? P.bg[1] : P.ink}55 1.6px, transparent 1.8px);background-size:15px 15px;-webkit-mask-image:radial-gradient(circle at 100% 100%,#000 30%,transparent 72%)}
      .arc{position:absolute;right:-90px;bottom:-150px;width:300px;height:300px;border-radius:50%;border:22px solid ${dark ? P.bg[1] : P.ink}14}
      .stripe{position:absolute;left:0;bottom:0;width:100%;height:10px;background:linear-gradient(90deg,${dark ? P.bg[1] : P.ink},${dark ? P.bg[2] : P.accent})}
      .copy{position:absolute;left:58px;right:150px;top:44px;bottom:46px;display:flex;flex-direction:column;justify-content:center;gap:18px}
      .tag{align-self:flex-start;padding:0;color:${dark ? P.bg[2] : P.accent};letter-spacing:.22em}
      .tag i{display:none}
      .title{color:#16130f;font-weight:900;letter-spacing:-.015em;line-height:1.04}
      .hl{position:relative;white-space:nowrap;font-style:italic;color:${dark ? P.bg[1] : P.accent}}
      .hl:after{content:'';position:absolute;left:-2%;right:-2%;bottom:.08em;height:.32em;background:${P.accent};opacity:.45;z-index:-1;border-radius:3px;transform:skewX(-12deg)}
      .title{position:relative;z-index:1}
      .brand{color:#4a4238} .logo{background:#16130f;color:${paper}}
    </style>
    <div class="c">
      <div class="corner"></div><div class="corner2"></div><div class="arc"></div><div class="mdots"></div><div class="frame"></div>
      <div class="copy">
        <div class="tag">${esc(o.tag)}</div>
        <h1 class="title fit">${o.headline}</h1>
        ${brand}
      </div>
      <div class="stripe"></div><div class="grain"></div>
    </div>`;
  } else if (o.style === 'split') {
    body = `
    <style>
      .c{background:linear-gradient(150deg, ${P.bg[0]}, ${P.bg[1]})}
      .ph,.edge{position:absolute;right:0;top:0;width:52%;height:100%;clip-path:polygon(18% 0,100% 0,100% 100%,0 100%)}
      .ph{background:url('${o.photo}') center/cover;box-shadow:inset 30px 0 40px -20px rgba(0,0,0,.45)}
      .edge{right:12px;background:${P.accent}}
      .blob{position:absolute;width:260px;height:260px;left:-80px;bottom:-120px;border-radius:50%;background:${P.glow[0]};filter:blur(70px);opacity:.6}
      .copy{position:absolute;left:44px;top:44px;bottom:44px;width:305px;display:flex;flex-direction:column;justify-content:center;gap:16px;z-index:3}
      .tag{align-self:flex-start;color:${P.ink};background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22)}
      .title{color:${P.ink}} .hl{color:${P.accent};white-space:nowrap}
      .bar{width:56px;height:5px;border-radius:5px;background:${P.accent}}
      .brand{color:${P.sub}} .logo{background:${P.accent};color:#111}
    </style>
    <div class="c">
      <div class="blob"></div><div class="edge"></div><div class="ph"></div>
      <div class="copy"><div class="tag"><i></i>${esc(o.tag)}</div><h1 class="title fit">${o.headline}</h1><div class="bar"></div>${brand}</div>
      <div class="grain"></div>
    </div>`;
  } else { // photo
    body = `
    <style>
      .c{background:url('${o.photo}') center/cover}
      .shade{position:absolute;inset:0;background:linear-gradient(100deg, ${P.bg[0]}f2 0%, ${P.bg[0]}c0 42%, ${P.bg[1]}30 75%, transparent 100%)}
      .shade2{position:absolute;inset:0;background:linear-gradient(0deg, ${P.bg[0]}cc 0%, transparent 45%)}
      .copy{position:absolute;left:46px;top:44px;bottom:44px;width:480px;display:flex;flex-direction:column;justify-content:flex-end;gap:16px}
      .tag{align-self:flex-start;color:#111;background:${P.accent}} .tag i{background:#111;box-shadow:none}
      .title{color:#fff;text-shadow:0 2px 30px rgba(0,0,0,.45)} .hl{color:${P.accent};white-space:nowrap}
      .brand{color:#e8e8e8} .logo{background:${P.accent};color:#111}
    </style>
    <div class="c"><div class="shade"></div><div class="shade2"></div>
      <div class="copy"><div class="tag"><i></i>${esc(o.tag)}</div><h1 class="title fit">${o.headline}</h1>${brand}</div>
      <div class="grain"></div>
    </div>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?${fonts}&display=block" rel="stylesheet">
  <style>${css}</style></head><body>${body}</body></html>`;
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (!a.keyword) { console.error('Missing --keyword'); process.exit(1); }
  const style = a.style || 'bold';
  if (!['bold', 'minimal', 'split', 'photo'].includes(style)) { console.error('Unknown --style ' + style); process.exit(1); }
  if ((style === 'split' || style === 'photo') && !a.photo) { console.error(`--style ${style} needs --photo <path>`); process.exit(1); }

  const names = Object.keys(PALETTES);
  const paletteName = a.palette && PALETTES[a.palette] ? a.palette : names[hash(a.keyword) % 6]; // auto-pick among dark palettes
  const title = titleCase(a.keyword);
  const tag = a.tag || guessTag(a.keyword);
  const o = {
    style, paletteName, pal: PALETTES[paletteName], tag, brand: a.brand,
    chip: tag.split(/\s+/)[0].replace(/-.*/, '') === 'How' ? 'Step by step' : (tag === 'Top Picks' ? 'Tested picks' : 'Expert tips'),
    headline: headlineHTML(title, a.highlight), photo: photoURI(a.photo),
  };
  const out = path.resolve(a.out || slugify(a.keyword) + '.webp');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(buildHTML(o), { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]);
      // film grain (raster noise)
      const n = document.createElement('canvas'); n.width = n.height = 160;
      const g = n.getContext('2d'), d = g.createImageData(160, 160);
      for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
      document.querySelectorAll('.grain').forEach(el => { el.style.backgroundImage = `url(${n.toDataURL()})`; });
      // fit headline: largest size that keeps it within 3 lines and inside its box
      const t = document.querySelector('.fit'), box = t.parentElement;
      const others = [...box.children].filter(c => c !== t).reduce((s, c) => s + c.offsetHeight, 0);
      const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
      const maxH = box.clientHeight - others - gap * (box.children.length - 1);
      for (let fs = 62; fs >= 24; fs -= 1) {
        t.style.fontSize = fs + 'px';
        const lh = parseFloat(getComputedStyle(t).lineHeight);
        if (t.scrollWidth <= t.clientWidth + 1 && t.offsetHeight <= maxH && Math.round(t.offsetHeight / lh) <= 3) break;
      }
    });
    const png = await page.screenshot({ type: 'png' });
    // downsample 2x render to exactly 768x401 and encode WebP in the browser
    const webp = await page.evaluate(async ({ b64, W, H, q }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, W, H);
      return c.toDataURL('image/webp', q).split(',')[1];
    }, { b64: png.toString('base64'), W, H, q: parseFloat(a.quality || '0.92') });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(webp, 'base64'));
    console.log(JSON.stringify({ file: out, width: W, height: H, style, palette: paletteName, headline: title }));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
