#!/usr/bin/env node
/**
 * AlphaVision · publish.mjs — EL ESLABÓN QUE FALTABA
 * ---------------------------------------------------------------
 * Tu render.mjs deja el vídeo en Supabase Storage y marca video_url
 * en content_calendar, pero nadie publica en Instagram ni rellena
 * ig_media_id. Esto lo hace.
 *
 * Flujo:
 *   1. Lee content_calendar las filas con status='pending',
 *      publish_date <= hoy, video_url ya presente, plataforma instagram.
 *   2. Para cada una: crea contenedor REELS con el video_url público de
 *      Supabase + caption (caption_base + hashtags), hace polling y publica.
 *   3. Escribe ig_media_id y status='published' (o 'error' + error_msg).
 *
 * Encaja con tu esquema 01_content_calendar.sql tal cual.
 *
 * Secrets necesarios:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   (ya los tienes)
 *   IG_USER_ID, IG_ACCESS_TOKEN          (cuenta IG Business/Creator)
 * Opcional:
 *   DRY_RUN=1  → no publica, solo muestra qué haría
 *   LIMIT=1    → máximo de reels por ejecución (por defecto 1; IG cap 25/día)
 */
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const IG_USER_ID = process.env.IG_USER_ID;
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const DRY = process.env.DRY_RUN === '1';
const LIMIT = parseInt(process.env.LIMIT || '1', 10);
const GRAPH = 'https://graph.facebook.com/v25.0';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${r.status} ${url}\n${JSON.stringify(d)}`);
  return d;
}
const sb = (path, opt = {}) => j(`${SB_URL}/rest/v1/${path}`, {
  ...opt,
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opt.headers || {}) },
});

// ---- publicar un reel en Instagram (Graph API v25.0) ----
async function publishReel(videoUrl, caption) {
  const container = await j(`${GRAPH}/${IG_USER_ID}/media`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: IG_TOKEN }),
  });
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const st = await j(`${GRAPH}/${container.id}?fields=status_code&access_token=${IG_TOKEN}`);
    console.log(`   procesando: ${st.status_code}`);
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR') throw new Error('Meta ERROR al procesar el vídeo');
    if (i === 29) throw new Error('Timeout de procesamiento');
  }
  const pub = await j(`${GRAPH}/${IG_USER_ID}/media_publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: container.id, access_token: IG_TOKEN }),
  });
  return pub.id;
}

(async () => {
  if (!SB_URL || !SB_KEY) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY');

  // filas listas: pendientes, con vídeo, fecha vencida, para instagram
  const today = new Date().toISOString().slice(0, 10);
  const q = `content_calendar?status=eq.pending&video_url=not.like.REEMPLAZAR*&publish_date=lte.${today}` +
            `&platforms=cs.{instagram}&order=publish_date.asc,publish_time.asc&limit=${LIMIT}`;
  const rows = await sb(q);

  if (!rows.length) { console.log('No hay reels pendientes para hoy.'); return; }

  for (const row of rows) {
    const caption = `${row.caption_base}\n\n${row.hashtags || ''}`.trim();
    console.log(`\n▶ Reel #${row.reel_number} · ${row.title}`);
    if (DRY) {
      console.log('  🧪 DRY_RUN — no publica. Caption:\n');
      console.log(caption);
      continue;
    }
    // marca processing (evita dobles publicaciones si algo reintenta)
    await sb(`content_calendar?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'processing' }) });
    try {
      const mediaId = await publishReel(row.video_url, caption);
      await sb(`content_calendar?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'published', ig_media_id: mediaId, error_msg: null }),
      });
      console.log(`  ✅ Publicado. ig_media_id=${mediaId}`);
    } catch (e) {
      await sb(`content_calendar?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'error', error_msg: String(e).slice(0, 500) }),
      });
      console.error(`  ❌ Error: ${e.message}`);
    }
  }
})();
