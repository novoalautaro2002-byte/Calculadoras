// ═══════════════════════════════════════════════════════════════════════════
//  netlify/functions/lecaps.js
//  Proxy server-side para LECAPs y BONCAPs
//
//  Cadena de fuentes (en orden de prioridad):
//    1. ArgentinaDatos — /v1/finanzas/cotizaciones/letras
//                        /v1/finanzas/cotizaciones/bonos   (para BONCAPs)
//    2. data912.com    — /live/arg_notes + /live/arg_bonds  (fallback)
//
//  Sin problemas de CORS: las llamadas salen del servidor Netlify.
//  Cache: 30 s (Cache-Control en headers).
// ═══════════════════════════════════════════════════════════════════════════

const https = require('https');

// ── Tickers que nos interesan ───────────────────────────────────────────────
const KNOWN_LECAPS = new Set([
  'S17A6','S30A6','S15Y6','S29Y6','S31L6',
  'S31G6','S30S6','S30O6','S30N6',
]);
const KNOWN_BONCAPS = new Set([
  'T30J6','T15E7','T30A7','T31Y7','T30J7',
]);
const ALL_KNOWN = new Set([...KNOWN_LECAPS, ...KNOWN_BONCAPS]);

// ── Fetcher genérico con timeout ───────────────────────────────────────────
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'portfolio-app/2.0',
        'Accept': 'application/json',
      },
    }, (res) => {
      // Seguir redireccionamientos simples (301/302)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    });
  });
}

// ── Normalizadores ─────────────────────────────────────────────────────────

/**
 * ArgentinaDatos format:
 * [{ ticker, ultimo, variacion, apertura, maximo, minimo, volumen, fecha }, ...]
 */
function normalizeArgentinadatos(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const ticker = String(item.ticker || item.simbolo || '').trim().toUpperCase();
    if (!ALL_KNOWN.has(ticker)) continue;
    const price = parseFloat(item.ultimo ?? item.c ?? item.precio ?? 0);
    if (!price || price <= 0) continue;
    out.push({
      ticker,
      price,
      varPct: parseFloat(item.variacion ?? item.variacion_pct ?? item.pct_change ?? 0),
    });
  }
  return out;
}

/**
 * data912 format:
 * [{ ticker, c (cierre), pct_change, ... }, ...]
 */
function normalizeData912(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const ticker = String(item.ticker || item.symbol || item.t || '').replace(/\s/g, '').toUpperCase();
    if (!ALL_KNOWN.has(ticker)) continue;
    const price = parseFloat(item.c ?? item.ultimo ?? item.last ?? item.precio ?? 0);
    if (!price || price <= 0) continue;
    out.push({
      ticker,
      price,
      varPct: parseFloat(item.pct_change ?? item.variacion ?? 0),
    });
  }
  return out;
}

// ── Merge sin duplicados (primera fuente tiene precedencia) ────────────────
function merge(...arrays) {
  const seen = new Set();
  const result = [];
  for (const arr of arrays) {
    for (const item of arr) {
      if (!seen.has(item.ticker)) {
        seen.add(item.ticker);
        result.push(item);
      }
    }
  }
  return result;
}

// ── Handler principal ──────────────────────────────────────────────────────
exports.handler = async () => {
  const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
  };

  let data = [];
  let source = '';
  const errors = [];

  // ── Fuente 1: ArgentinaDatos ─────────────────────────────────────────────
  try {
    const [letras, bonos] = await Promise.allSettled([
      fetchJson('https://api.argentinadatos.com/v1/finanzas/cotizaciones/letras'),
      fetchJson('https://api.argentinadatos.com/v1/finanzas/cotizaciones/bonos'),
    ]);

    const fromLetras = letras.status === 'fulfilled'
      ? normalizeArgentinadatos(letras.value)
      : (errors.push('argentinadatos/letras: ' + letras.reason?.message), []);

    const fromBonos = bonos.status === 'fulfilled'
      ? normalizeArgentinadatos(bonos.value)
      : (errors.push('argentinadatos/bonos: ' + bonos.reason?.message), []);

    const merged = merge(fromLetras, fromBonos);
    if (merged.length > 0) {
      data = merged;
      source = 'argentinadatos';
    }
  } catch (e) {
    errors.push('argentinadatos: ' + e.message);
  }

  // ── Fuente 2: data912.com (fallback) ─────────────────────────────────────
  if (data.length < 3) {
    try {
      const [notes, bonds] = await Promise.allSettled([
        fetchJson('https://data912.com/live/arg_notes'),
        fetchJson('https://data912.com/live/arg_bonds'),
      ]);

      const fromNotes = notes.status === 'fulfilled'
        ? normalizeData912(Array.isArray(notes.value) ? notes.value : notes.value?.data ?? [])
        : (errors.push('data912/notes: ' + notes.reason?.message), []);

      const fromBonds = bonds.status === 'fulfilled'
        ? normalizeData912(Array.isArray(bonds.value) ? bonds.value : bonds.value?.data ?? [])
        : (errors.push('data912/bonds: ' + bonds.reason?.message), []);

      const d912Merged = merge(fromNotes, fromBonds);

      if (d912Merged.length > 0) {
        // Merge con lo que ya teníamos (ArgentinaDatos tiene prioridad)
        data = merge(data, d912Merged);
        source = source ? source + '+data912' : 'data912';
      }
    } catch (e) {
      errors.push('data912: ' + e.message);
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      data,             // [{ ticker, price, varPct }]
      source,
      count: data.length,
      ts: Date.now(),
      errors: errors.length ? errors : undefined,
    }),
  };
};
