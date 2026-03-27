// ═══════════════════════════════════════════════════════════════════════════
//  netlify/functions/soberanos.js
//  Proxy server-side para bonos soberanos USD (precios MEP — sufijo "D")
//
//  Cadena de fuentes (en orden de prioridad):
//    1. rendimientos.co   — /api/soberanos  (fuente ya validada en el front)
//    2. ArgentinaDatos    — /v1/finanzas/cotizaciones/bonos
//    3. data912.com       — /live/arg_bonds (tickers con sufijo D)
//
//  Devuelve: [{ ticker: "AL30D", price: 72.50, varPct: 0.5 }, ...]
// ═══════════════════════════════════════════════════════════════════════════

const https = require('https');

// ── Tickers base (sin sufijo D). Mapeamos al precio USD MEP. ───────────────
const BOND_BASE_TICKERS = new Set([
  'AL29','AL30','AL35','AL38','AL41',
  'GD29','GD30','GD35','GD38','GD41','GD46',
  'BPY26','BPOA7','BPD27',
  'AO27','AN29','BPD7','AE38',      // tickers alternativos
]);

// Tickers completos con sufijo D que pueden aparecer en APIs
const BOND_D_TICKERS = new Set(
  [...BOND_BASE_TICKERS].map(t => t + 'D')
);

// ── Fetcher genérico con timeout ───────────────────────────────────────────
function fetchJson(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'portfolio-app/2.0',
        'Accept': 'application/json',
      },
    }, (res) => {
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
      reject(new Error(`timeout ${timeoutMs}ms`));
    });
  });
}

// ── Normalizadores ─────────────────────────────────────────────────────────

/**
 * rendimientos.co /api/soberanos puede devolver:
 *   a) Array: [{ ticker, price|c|ultimo, changePct|pct_change }, ...]
 *   b) Objeto: { AL30: { price, varPct }, AL30D: {...}, ... }
 */
function normalizeRendimientos(raw) {
  const out = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const ticker = String(item.ticker || item.symbol || item.t || '').trim().toUpperCase();
      // Aceptamos tanto el ticker base como con sufijo D
      const isBase = BOND_BASE_TICKERS.has(ticker);
      const isD    = BOND_D_TICKERS.has(ticker);
      if (!isBase && !isD) continue;
      const price = parseFloat(item.price ?? item.c ?? item.ultimo ?? item.last ?? 0);
      if (!price || price <= 0) continue;
      // Normalizar siempre con sufijo D (precio USD)
      const finalTicker = isD ? ticker : ticker + 'D';
      out.push({
        ticker: finalTicker,
        price,
        varPct: parseFloat(item.changePct ?? item.pct_change ?? item.variacion ?? item.var ?? 0),
      });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, val] of Object.entries(raw)) {
      const ticker = key.trim().toUpperCase();
      const isBase = BOND_BASE_TICKERS.has(ticker);
      const isD    = BOND_D_TICKERS.has(ticker);
      if (!isBase && !isD) continue;
      const price = parseFloat(
        typeof val === 'number' ? val
          : (val?.price ?? val?.c ?? val?.ultimo ?? val?.last ?? 0)
      );
      if (!price || price <= 0) continue;
      const finalTicker = isD ? ticker : ticker + 'D';
      out.push({
        ticker: finalTicker,
        price,
        varPct: parseFloat(val?.varPct ?? val?.changePct ?? val?.pct_change ?? 0),
      });
    }
  }

  return out;
}

/**
 * ArgentinaDatos format:
 * [{ ticker, ultimo, variacion, ... }, ...]
 * Los USD MEP deberían aparecer con sufijo D.
 */
function normalizeArgentinadatos(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const ticker = String(item.ticker || item.simbolo || '').trim().toUpperCase();
    const isBase = BOND_BASE_TICKERS.has(ticker);
    const isD    = BOND_D_TICKERS.has(ticker);
    if (!isBase && !isD) continue;
    const price = parseFloat(item.ultimo ?? item.c ?? item.precio ?? 0);
    if (!price || price <= 0) continue;
    const finalTicker = isD ? ticker : ticker + 'D';
    out.push({
      ticker: finalTicker,
      price,
      varPct: parseFloat(item.variacion ?? item.variacion_pct ?? item.pct_change ?? 0),
    });
  }
  return out;
}

/**
 * data912 format:
 * [{ ticker: "AL30D", c: 72.50, pct_change: 0.5, ... }, ...]
 * Solo importan los tickers con sufijo D (precio USD MEP).
 */
function normalizeData912(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const ticker = String(item.ticker || item.symbol || item.t || '').replace(/\s/g, '').toUpperCase();
    if (!BOND_D_TICKERS.has(ticker)) continue;
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

// ── Merge sin duplicados (primera fuente = mayor prioridad) ────────────────
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
  const MIN_BONDS = 4; // mínimo aceptable para considerar una fuente útil

  // ── Fuente 1: rendimientos.co ────────────────────────────────────────────
  try {
    const raw = await fetchJson('https://rendimientos.co/api/soberanos');
    const normalized = normalizeRendimientos(raw);
    if (normalized.length >= MIN_BONDS) {
      data = normalized;
      source = 'rendimientos.co';
    } else {
      errors.push(`rendimientos.co: solo ${normalized.length} bonos`);
      // Guardar lo que vino igual (puede complementar después)
      data = normalized;
      source = normalized.length > 0 ? 'rendimientos.co(parcial)' : '';
    }
  } catch (e) {
    errors.push('rendimientos.co: ' + e.message);
  }

  // ── Fuente 2: ArgentinaDatos ─────────────────────────────────────────────
  if (data.length < MIN_BONDS) {
    try {
      const raw = await fetchJson('https://api.argentinadatos.com/v1/finanzas/cotizaciones/bonos');
      const normalized = normalizeArgentinadatos(raw);
      if (normalized.length > 0) {
        data = merge(data, normalized); // rendimientos.co tiene precedencia
        source = source ? source + '+argentinadatos' : 'argentinadatos';
      }
    } catch (e) {
      errors.push('argentinadatos: ' + e.message);
    }
  }

  // ── Fuente 3: data912.com ────────────────────────────────────────────────
  if (data.length < MIN_BONDS) {
    try {
      const raw = await fetchJson('https://data912.com/live/arg_bonds');
      const arr = Array.isArray(raw) ? raw : (raw?.data ?? raw?.items ?? []);
      const normalized = normalizeData912(arr);
      if (normalized.length > 0) {
        data = merge(data, normalized);
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
      data,             // [{ ticker: "AL30D", price, varPct }]
      source,
      count: data.length,
      ts: Date.now(),
      errors: errors.length ? errors : undefined,
    }),
  };
};
