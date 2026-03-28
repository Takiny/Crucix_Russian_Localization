// LLM-driven content translation with on-disk cache.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RUNS_DIR = join(ROOT, 'runs');
const CACHE_PATH = join(RUNS_DIR, 'translation-cache.json');
const cyrillic = /[\u0400-\u04FF]/;

function clampText(s, maxChars) {
  if (!s) return s;
  const str = String(s);
  return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str;
}

function hashText(text, targetLang) {
  return createHash('sha1').update(`${targetLang}::${text}`).digest('hex');
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function loadCache() {
  try {
    if (!existsSync(CACHE_PATH)) return {};
    const raw = readFileSync(CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const tmp = CACHE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  writeFileSync(CACHE_PATH, readFileSync(tmp));
}

function shouldTranslate(text, targetLang) {
  if (!text) return false;
  const s = String(text).trim();
  if (!s) return false;
  // If targeting Russian and already contains Cyrillic, skip.
  if (targetLang === 'ru' && cyrillic.test(s)) return false;
  // Avoid translating obvious URLs.
  if (/^https?:\/\//i.test(s)) return false;
  return true;
}

async function translateBatch(llmProvider, items, targetLang) {
  const systemPrompt = [
    `You are a high-accuracy translation engine.`,
    `Translate each input string into ${targetLang}.`,
    `Rules:`,
    `- Preserve numbers, dates, tickers, and abbreviations (e.g., NATO, USD, VIX, BTC, WTI, CL=F).`,
    `- Do NOT translate URLs; keep them exactly as-is.`,
    `- Keep proper nouns recognizable (people/places/organizations).`,
    `- Keep punctuation and casing style similar to input.`,
    `- Output ONLY valid JSON: an array of translated strings in the same order.`,
  ].join('\n');

  const userMessage = JSON.stringify(items);
  const { text } = await llmProvider.complete(systemPrompt, userMessage, { maxTokens: 4096, timeout: 90000 });

  const parsed = safeJsonParse(text.trim());
  if (!Array.isArray(parsed) || parsed.length !== items.length) {
    throw new Error(`Translate parse failed: expected JSON array length ${items.length}`);
  }
  return parsed.map((s, i) => (typeof s === 'string' && s.trim() ? s : items[i]));
}

/**
 * Mutates synthesized dashboard data in-place.
 * Translates text-heavy fields: RSS/GDELT headlines, unified newsFeed, Telegram post text, WHO summaries.
 */
export async function translateSynthesizedData(synth, llmProvider, opts = {}) {
  const enabled = Boolean(opts.enabled);
  const targetLang = opts.targetLang || null;
  if (!enabled || !targetLang) return { translated: 0, cached: 0, batches: 0 };
  if (!llmProvider?.isConfigured) return { translated: 0, cached: 0, batches: 0 };

  const maxItemsPerRequest = Math.max(5, Math.min(100, opts.maxItemsPerRequest || 40));
  const maxCharsPerItem = Math.max(80, Math.min(600, opts.maxCharsPerItem || 240));

  const cache = loadCache();

  // Collect (getter/setter) pairs so we can patch strings back after translation.
  const slots = [];
  const addSlot = (get, set) => {
    const original = get();
    if (!shouldTranslate(original, targetLang)) return;
    const text = clampText(original, maxCharsPerItem);
    const key = hashText(text, targetLang);
    slots.push({ get, set, text, key });
  };

  // RSS news points on the map
  for (const n of (synth.news || [])) {
    addSlot(() => n.title, v => { n.title = v; });
    addSlot(() => n.source, v => { n.source = v; }); // optional, some sources are English
    addSlot(() => n.region, v => { n.region = v; });
  }

  // Unified ticker feed
  for (const f of (synth.newsFeed || [])) {
    addSlot(() => f.headline, v => { f.headline = v; });
    addSlot(() => f.region, v => { f.region = v; });
  }

  // GDELT topTitles + geo points names
  for (const t of (synth.gdelt?.topTitles || [])) {
    // topTitles is an array of strings; replace by index
  }
  if (Array.isArray(synth.gdelt?.topTitles)) {
    synth.gdelt.topTitles.forEach((_, idx) => {
      addSlot(() => synth.gdelt.topTitles[idx], v => { synth.gdelt.topTitles[idx] = v; });
    });
  }
  if (Array.isArray(synth.gdelt?.geoPoints)) {
    synth.gdelt.geoPoints.forEach(p => {
      addSlot(() => p.name, v => { p.name = v; });
    });
  }

  // Telegram posts (already filtered to non-Cyrillic in inject.mjs — we'll translate them)
  for (const p of (synth.tg?.urgent || [])) addSlot(() => p.text, v => { p.text = v; });
  for (const p of (synth.tg?.topPosts || [])) addSlot(() => p.text, v => { p.text = v; });

  // WHO items
  for (const w of (synth.who || [])) {
    addSlot(() => w.title, v => { w.title = v; });
    addSlot(() => w.summary, v => { w.summary = v; });
  }

  // Signal-based ideas (non-LLM)
  for (const idea of (synth.ideas || [])) {
    addSlot(() => idea.title, v => { idea.title = v; });
    addSlot(() => idea.text, v => { idea.text = v; });
  }

  let cached = 0;
  let translated = 0;
  let batches = 0;

  // Build list of missing translations
  const pending = [];
  for (const slot of slots) {
    const hit = cache[slot.key];
    if (typeof hit === 'string' && hit.trim()) {
      slot.set(hit);
      cached += 1;
    } else {
      pending.push(slot);
    }
  }

  // Translate in batches
  for (let i = 0; i < pending.length; i += maxItemsPerRequest) {
    const chunk = pending.slice(i, i + maxItemsPerRequest);
    const inputs = chunk.map(s => s.text);
    const outputs = await translateBatch(llmProvider, inputs, targetLang);
    batches += 1;
    outputs.forEach((out, j) => {
      const slot = chunk[j];
      const val = typeof out === 'string' && out.trim() ? out : slot.text;
      slot.set(val);
      cache[slot.key] = val;
      translated += 1;
    });
  }

  // Persist cache (best-effort)
  try { saveCache(cache); } catch {}

  return { translated, cached, batches };
}

