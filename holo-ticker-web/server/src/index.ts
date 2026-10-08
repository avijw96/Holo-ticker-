/**
 * Holo Ticker server — a Cloudflare Worker that keeps your API keys off the phone.
 *
 *   GET  /health            → { ok: true }
 *   POST /identify          { imageBase64, mediaType } → { card, matches }
 *   GET  /search?q=...      → { matches }
 *   POST /prices            { ids: string[] } → { results: { [id]: { productName, set, prices } | null } }
 *
 * Secrets (set with `npx wrangler secret put NAME`):
 *   ANTHROPIC_API_KEY   your Claude API key
 *   PRICECHARTING_TOKEN your PriceCharting API token (paid subscription)
 *   APP_KEY             any long random string; the app sends it in the x-app-key header
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  ANTHROPIC_API_KEY: string;
  PRICECHARTING_TOKEN: string;
  APP_KEY: string;
  CLAUDE_MODEL?: string;
};

const PC = 'https://www.pricecharting.com/api';
const PRICE_TTL_S = 30 * 60; // cache each product's prices for 30 min

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

app.use('*', async (c, next) => {
  if (c.req.path === '/health' && c.req.method === 'GET' && !c.req.header('x-app-key')) return next();
  if (!c.env.APP_KEY || c.req.header('x-app-key') !== c.env.APP_KEY) return c.json({ error: 'Wrong app key. Check it in the app Settings.' }, 401);
  return next();
});

app.get('/health', (c) => c.json({ ok: true }));

/* ---------------- PriceCharting helpers (1 request / second limit) ---------------- */

let lastCall = 0;
async function pcFetch(env: Env, path: string, params: Record<string, string>) {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const qs = new URLSearchParams({ ...params, t: env.PRICECHARTING_TOKEN });
  const res = await fetch(`${PC}/${path}?${qs}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.status === 'error') throw new Error(String(body['error-message'] ?? `PriceCharting error ${res.status}`));
  return body;
}

const cents = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v) / 100 : null);

function mapPrices(p: Record<string, unknown>) {
  return {
    ungraded: cents(p['loose-price']),
    grade7: cents(p['cib-price']),
    grade8: cents(p['new-price']),
    grade9: cents(p['graded-price']),
    grade95: cents(p['box-only-price']),
    psa10: cents(p['manual-only-price']),
    bgs10: cents(p['bgs-10-price']),
    cgc10: cents(p['condition-17-price']),
    sgc10: cents(p['condition-18-price']),
  };
}

type Match = { id: string; name: string; set: string };

async function searchCards(env: Env, q: string): Promise<Match[]> {
  const body = await pcFetch(env, 'products', { q: `pokemon ${q}` });
  const list = (body.products as Record<string, unknown>[] | undefined) ?? [];
  return list
    .filter((p) => /pokemon/i.test(String(p['console-name'] ?? '')))
    .map((p) => ({ id: String(p.id), name: String(p['product-name']), set: String(p['console-name']).replace(/^Pokemon\s+/i, '') }));
}

app.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 160);
  if (!q) return c.json({ matches: [] });
  try {
    return c.json({ matches: await searchCards(c.env, q) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.post('/prices', async (c) => {
  const { ids } = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: [] as string[] }));
  const list = [...new Set((ids ?? []).map(String))].filter((x) => /^\d+$/.test(x)).slice(0, 25);
  const cache = (caches as unknown as { default: Cache }).default;
  const results: Record<string, unknown> = {};
  for (const id of list) {
    const key = new Request(`https://cache.holo-ticker/product/${id}`);
    const hit = await cache.match(key);
    if (hit) {
      results[id] = await hit.json();
      continue;
    }
    try {
      const p = await pcFetch(c.env, 'product', { id });
      const out = { productName: String(p['product-name'] ?? ''), set: String(p['console-name'] ?? '').replace(/^Pokemon\s+/i, ''), prices: mapPrices(p) };
      results[id] = out;
      c.executionCtx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': `max-age=${PRICE_TTL_S}` } })));
    } catch {
      results[id] = null;
    }
  }
  return c.json({ results });
});

/* ---------------- Card identification with Claude ---------------- */

const ID_PROMPT = `This photo shows a Pokémon Trading Card Game card. Identify it exactly and pre-screen its condition for professional grading.
Reply with only one JSON object in this shape:
{"is_pokemon_card":true,"name":"Charizard","set":"Base Set","number":"4","year":1999,"variant":"Holo, Unlimited","language":"English","confidence":0.9,"id_notes":"short note on how you identified it or what is uncertain","search_query":"Charizard Base Set 4","condition":{"centering":"approx. 55/45 left-right, 60/40 top-bottom","corners":"...","edges":"...","surface":"...","summary":"one sentence"},"grade_odds":{"10":0.05,"9":0.35,"8":0.4,"7":0.2}}
Rules: use the English set name; number is the collector number before the slash; variant lists edition marks (1st Edition, Shadowless), holo / reverse holo, full art / alt art / secret rare, promo stamps. search_query is what to type into a price guide search, including "1st Edition" or "Shadowless" when present. grade_odds are probabilities summing to 1 for PSA 10, 9, 8, and 7-or-lower, based only on what is visible. Photos hide fine scratches and print lines, so be conservative, and lower the odds for a blurry or angled photo. If it is not a Pokémon card, set is_pokemon_card to false.`;

function parseJson(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const numOrNull = (v: unknown) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);

app.post('/identify', async (c) => {
  const { imageBase64, mediaType } = await c.req.json<{ imageBase64?: string; mediaType?: string }>().catch(() => ({}) as { imageBase64?: string; mediaType?: string });
  if (!imageBase64 || imageBase64.length < 100) return c.json({ error: 'No photo received.' }, 400);
  if (imageBase64.length > 7_000_000) return c.json({ error: 'Photo is too large.' }, 413);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': c.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: c.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: ID_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return c.json({ error: `Card recognition failed (${res.status}). ${detail.slice(0, 200)}` }, 502);
  }
  const msg = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (msg.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const r = parseJson(text);
  if (!r) return c.json({ error: "Couldn't read the card clearly. Try a sharper, straight-on photo." }, 422);

  const cond = (r.condition ?? {}) as Record<string, unknown>;
  const go = (r.grade_odds ?? null) as Record<string, unknown> | null;
  const card = {
    isPokemonCard: r.is_pokemon_card !== false,
    name: str(r.name),
    set: str(r.set),
    number: str(r.number).split('/')[0],
    year: numOrNull(r.year),
    variant: str(r.variant),
    language: str(r.language) || 'English',
    confidence: numOrNull(r.confidence),
    idNotes: str(r.id_notes),
    condition: { centering: str(cond.centering), corners: str(cond.corners), edges: str(cond.edges), surface: str(cond.surface), summary: str(cond.summary) },
    odds: go ? { '10': numOrNull(go['10']) ?? 0, '9': numOrNull(go['9']) ?? 0, '8': numOrNull(go['8']) ?? 0, '7': numOrNull(go['7']) ?? 0 } : null,
  };

  let matches: Match[] = [];
  if (card.isPokemonCard && card.name) {
    const q = str(r.search_query) || [card.name, card.set, card.number].join(' ');
    matches = await searchCards(c.env, q).catch(() => []);
    // Put the variant that matches the photo first (e.g. "[1st Edition]").
    const wants1st = /1st edition/i.test(card.variant), wantsShadowless = /shadowless/i.test(card.variant);
    const score = (m: Match) =>
      (m.name.toLowerCase().includes(`#${card.number}`.toLowerCase()) ? 4 : 0) +
      (/1st edition/i.test(m.name) === wants1st ? 2 : 0) +
      (/shadowless/i.test(m.name) === wantsShadowless ? 1 : 0) +
      (m.set.toLowerCase().includes(card.set.toLowerCase()) ? 2 : 0);
    matches.sort((a, b) => score(b) - score(a));
  }
  return c.json({ card, matches });
});

export default app;
