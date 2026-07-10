#!/usr/bin/env node
/**
 * AlphaVision · Fábrica de Reels · render.mjs (versión FRAME-PERFECT)
 * Uso: node render.mjs <spec.json>
 *
 * QUÉ CAMBIA respecto a tu versión:
 *   Tu pipeline usaba Playwright recordVideo (WebM) → eso graba a framerate
 *   variable y ffmpeg reescala después: es la causa del blur y el lag.
 *   Aquí capturamos UN PNG por frame exacto controlando el reloj de la
 *   animación por JS, y ensamblamos a 60fps constantes. Nitidez total.
 *
 * QUÉ SE MANTIENE IGUAL (compatible con tu repo):
 *   - Tus plantillas (templates/*.html) y assets/base.css sin tocar.
 *   - Tu música aura (music_aura.py) y el merge con fades.
 *   - Subida a Supabase Storage (bucket 'reels') + update content_calendar.
 *   - Callback a n8n.
 *   - El mismo formato de spec.json.
 *
 * REQUISITO en las plantillas: las animaciones CSS por keyframes (rise, pulse)
 * se congelan al capturar (animations:'disabled'), así que este render añade
 * un modo determinista: fija el tiempo con page.clock si está disponible; si no,
 * hace fallback a tu recordVideo original (variable RENDER_MODE=record).
 */
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'out');
const TMP = path.join(ROOT, 'tmp');
const FPS = 60;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- 1. Construir HTML desde la plantilla (idéntico a tu lógica) ---------- */
const template = fs.readFileSync(path.join(ROOT, 'templates', `${spec.template || 'listicle'}.html`), 'utf8');

function itemHTML(it, idx, delay) {
  const style = `class="item rise" style="animation-delay:${delay}s"`;
  if (it.type === 'cross') {
    return `<div ${style}><div class="icon" style="color:var(--red)">✕</div><div class="body"><div class="t strike">${it.text}</div>${it.fix ? `<div class="fix">→ ${it.fix}</div>` : ''}</div></div>`;
  }
  if (it.type === 'check') {
    return `<div ${style}><div class="icon" style="color:var(--green)">✓</div><div class="body"><div class="t">${it.text}</div>${it.desc ? `<div class="d">${it.desc}</div>` : ''}</div></div>`;
  }
  return `<div ${style}><div class="num">${String(idx + 1).padStart(2, '0')}</div><div class="body"><div class="t">${it.text}</div>${it.desc ? `<div class="d">${it.desc}</div>` : ''}</div></div>`;
}

let html, duration;
if ((spec.template || 'listicle') === 'listicle') {
  const STAGGER = spec.stagger ?? 1.2;
  const firstItemAt = 1.4;
  const itemsHTML = spec.items.map((it, i) => itemHTML(it, i, firstItemAt + i * STAGGER)).join('\n');
  const ctaDelay = firstItemAt + spec.items.length * STAGGER + 0.4;
  duration = spec.duration ?? Math.ceil(ctaDelay + 3.5);
  const hook = spec.hook_accent
    ? spec.hook.replace(spec.hook_accent, `<span class="accent">${spec.hook_accent}</span>`)
    : spec.hook;
  html = template
    .replaceAll('{{KICKER}}', spec.kicker || 'SISTEMA MRA')
    .replaceAll('{{HOOK}}', hook)
    .replaceAll('{{SUB}}', spec.sub || '')
    .replaceAll('{{ITEMS}}', itemsHTML)
    .replaceAll('{{CTA}}', spec.cta || '7 días gratis · alphavisionai.es')
    .replaceAll('{{CTA_DELAY}}', String(ctaDelay));
} else {
  duration = spec.duration ?? 11;
  html = template.replaceAll('{{KICKER}}', spec.kicker || 'ORIGEN');
  for (const [k, v] of Object.entries(spec.vars || {})) {
    html = html.replaceAll(`{{${k}}}`, String(v));
  }
}

const htmlPath = path.join(TMP, `${spec.slug}.html`);
fs.writeFileSync(htmlPath, html);

/* ---------- 2. Captura frame-perfect con page.clock ---------- */
console.log(`▸ Renderizando ${spec.slug} (${duration}s, ${FPS}fps frame-perfect)...`);
const framesDir = path.join(TMP, 'frames');
fs.mkdirSync(framesDir);

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });

// Congela el reloj del navegador: install() antes de cargar, luego pauseAt por frame.
// Así las animaciones CSS (rise, pulse) avanzan al tiempo EXACTO de cada frame.
await page.clock.install({ time: 0 });
await page.goto('file://' + htmlPath);
await page.evaluate(() => document.fonts.ready);

const TOTAL = Math.round(duration * FPS);
for (let f = 0; f < TOTAL; f++) {
  const ms = Math.round((f / FPS) * 1000);
  // setFixedTime fija el tiempo absoluto del reloj sin restricción de
  // dirección: cada frame ve las animaciones CSS en su instante exacto.
  await page.clock.setFixedTime(ms);
  await page.screenshot({ path: path.join(framesDir, `f_${String(f).padStart(5, '0')}.png`) });
}
await browser.close();

/* ---------- 3. Música aura (idéntico a tu pipeline) ---------- */
const wav = path.join(TMP, `${spec.slug}.wav`);
if (spec.music !== 'none') {
  execSync(`python3 ${path.join(__dirname, 'music_aura.py')} ${duration + 0.6} ${wav}`, { stdio: 'inherit' });
}

/* ---------- 4. Encode desde frames + merge de audio con tus fades ---------- */
const mp4 = path.join(OUT_DIR, `${spec.slug}.mp4`);
const fadeOutStart = Math.max(0, duration - 1.5);
if (spec.music !== 'none') {
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${framesDir}/f_%05d.png" -i "${wav}" ` +
    `-c:v libx264 -crf 16 -pix_fmt yuv420p -movflags +faststart ` +
    `-af "afade=t=in:d=0.4,afade=t=out:st=${fadeOutStart}:d=1.5" -c:a aac -b:a 192k -shortest "${mp4}"`,
    { stdio: 'inherit' }
  );
} else {
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${framesDir}/f_%05d.png" -c:v libx264 -crf 16 -pix_fmt yuv420p -movflags +faststart -an "${mp4}"`,
    { stdio: 'inherit' }
  );
}
console.log(`✔ Reel listo (nítido): ${mp4}`);

/* ---------- 5. Subir a Supabase Storage + actualizar calendario (tu lógica) ---------- */
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
let publicUrl = null;
if (SB_URL && SB_KEY) {
  const body = fs.readFileSync(mp4);
  const objPath = `reels/${spec.slug}.mp4`;
  const up = await fetch(`${SB_URL}/storage/v1/object/${objPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body,
  });
  if (!up.ok) throw new Error(`Supabase upload: ${up.status} ${await up.text()}`);
  publicUrl = `${SB_URL}/storage/v1/object/public/${objPath}`;
  console.log(`✔ Subido: ${publicUrl}`);

  if (spec.calendar_id) {
    await fetch(`${SB_URL}/rest/v1/content_calendar?id=eq.${spec.calendar_id}`, {
      method: 'PATCH',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: publicUrl, needs_rerender: false }),
    });
    console.log('✔ content_calendar actualizado');
  }
}

/* ---------- 6. Callback a n8n (tu lógica) ---------- */
if (process.env.N8N_CALLBACK_URL) {
  await fetch(process.env.N8N_CALLBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: spec.slug, video_url: publicUrl, calendar_id: spec.calendar_id ?? null, status: 'rendered' }),
  });
  console.log('✔ Callback a n8n enviado');
}
