/*
  REDE SINAIS — Proxy Server v2
  Parser melhorado para o TipMiner
*/

const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

let cache = {
  data: [],
  lastFetch: 0,
  ttl: 30000,
};

const ROULETTE_COLORS = {
  0:'branco',1:'vermelho',2:'preto',3:'vermelho',4:'preto',5:'vermelho',
  6:'preto',7:'vermelho',8:'preto',9:'vermelho',10:'preto',
  11:'preto',12:'vermelho',13:'preto',14:'vermelho',15:'preto',
  16:'vermelho',17:'preto',18:'vermelho',19:'vermelho',20:'preto',
  21:'vermelho',22:'preto',23:'vermelho',24:'preto',25:'vermelho',
  26:'preto',27:'vermelho',28:'preto',29:'preto',30:'vermelho',
  31:'preto',32:'vermelho',33:'preto',34:'vermelho',35:'preto',36:'vermelho',
};

function getColor(n) { return ROULETTE_COLORS[n] || 'branco'; }

function fetchTipMiner() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.tipminer.com',
      path: '/br/historico/evolution/xxxtreme-lightning-roulette',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      }
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`TipMiner: ${res.statusCode}, ${body.length} chars`);
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function timeToTimestamp(timeStr, now) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const brtNow = new Date(now - 3 * 3600000);
  const d = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate(), h + 3, m, s));
  let ts = d.getTime();
  if (ts > now + 60000) ts -= 24 * 3600000;
  return ts;
}

function deduplicateAndSort(results) {
  const seen = new Set();
  return results
    .filter(r => { if (seen.has(r.horario)) return false; seen.add(r.horario); return true; })
    .sort((a, b) => b.timestamp - a.timestamp);
}

function parseRoulette(html) {
  const results = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  console.log('HTML length:', html.length);

  // Estratégia 1: __NEXT_DATA__ JSON (Next.js SSR)
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const flat = JSON.stringify(nextData);
      // Buscar arrays de rodadas no JSON
      const arrMatches = [...flat.matchAll(/"(?:results|history|rounds|spins|records)"\s*:\s*(\[[\s\S]{10,5000}?\])/g)];
      for (const am of arrMatches) {
        try {
          const arr = JSON.parse(am[1]);
          for (const item of arr) {
            if (typeof item !== 'object') continue;
            const keys = Object.keys(item);
            // Procurar multiplicador
            const multKey = keys.find(k => /mult|lightning|bonus/i.test(k));
            const numKey = keys.find(k => /result|number|outcome|num/i.test(k));
            const timeKey = keys.find(k => /time|date|created|at$/i.test(k));
            if (!multKey) continue;
            const mult = parseInt(item[multKey]);
            if (isNaN(mult) || mult < 50) continue;
            const number = parseInt(item[numKey]) || 0;
            const timeVal = item[timeKey];
            let timeStr = null;
            if (typeof timeVal === 'string') { const tm = timeVal.match(/(\d{2}:\d{2}:\d{2})/); timeStr = tm ? tm[1] : null; }
            else if (typeof timeVal === 'number') {
              const d = new Date(timeVal < 1e12 ? timeVal * 1000 : timeVal);
              const utc = d.getTime() + d.getTimezoneOffset()*60000;
              const brt = new Date(utc - 3*3600000);
              timeStr = String(brt.getHours()).padStart(2,'0')+':'+String(brt.getMinutes()).padStart(2,'0')+':'+String(brt.getSeconds()).padStart(2,'0');
            }
            if (!timeStr) continue;
            const ts = timeToTimestamp(timeStr, now);
            if (ts < oneHourAgo) continue;
            results.push({ numero: number, cor: getColor(number), multiplicador: mult, todosMultiplicadores: [mult], horario: timeStr, timestamp: ts });
          }
          if (results.length > 0) { console.log('__NEXT_DATA__ encontrou', results.length, 'rodadas'); return deduplicateAndSort(results); }
        } catch(e) {}
      }
    } catch(e) {}
  }

  // Estratégia 2: JSON inline genérico
  const jsonMatches = [...html.matchAll(/\[\s*\{[^<]{50,3000}?"(?:time|hora|horario)"[^<]{0,2000}?\}/g)];
  for (const jm of jsonMatches) {
    try {
      const arr = JSON.parse(jm[0]);
      for (const item of arr) {
        const mult = item.mult || item.multiplier || item.lightning;
        const number = parseInt(item.result || item.number || item.num) || 0;
        const timeStr = (item.time || item.hora || item.horario || '').match(/\d{2}:\d{2}:\d{2}/)?.[0];
        if (!mult || mult < 50 || !timeStr) continue;
        const ts = timeToTimestamp(timeStr, now);
        if (ts < oneHourAgo) continue;
        results.push({ numero: number, cor: getColor(number), multiplicador: parseInt(mult), todosMultiplicadores: [parseInt(mult)], horario: timeStr, timestamp: ts });
      }
      if (results.length > 0) return deduplicateAndSort(results);
    } catch(e) {}
  }

  // Estratégia 3: tabela HTML
  const tableRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch, rowCount = 0;
  while ((rowMatch = tableRowRegex.exec(html)) !== null) {
    const row = rowMatch[1]; rowCount++;
    const timeMatch = row.match(/\b(\d{2}:\d{2}:\d{2})\b/);
    if (!timeMatch) continue;
    const timeStr = timeMatch[1];
    const ts = timeToTimestamp(timeStr, now);
    if (ts < oneHourAgo) continue;
    const multMatches = [...row.matchAll(/\b(\d{2,4})x\b/gi)];
    const multipliers = multMatches.map(m => parseInt(m[1])).filter(m => m >= 50);
    if (!multipliers.length) continue;
    const cleanRow = row.replace(/<[^>]+>/g, ' ');
    const nums = [...cleanRow.matchAll(/\b(3[0-6]|[12][0-9]|[0-9])\b/g)].map(m => parseInt(m[1])).filter(n => n >= 0 && n <= 36);
    const number = nums.length > 0 ? nums[0] : 0;
    results.push({ numero: number, cor: getColor(number), multiplicador: Math.max(...multipliers), todosMultiplicadores: multipliers, horario: timeStr, timestamp: ts });
  }
  console.log(`Tabela: ${rowCount} rows, ${results.length} com mult`);
  if (results.length > 0) return deduplicateAndSort(results);

  // Estratégia 4: regex no texto limpo
  const cleanHtml = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const pattern = /(\d{2}:\d{2}:\d{2})[^|]{0,200}?(\d{3,4})x/g;
  let m;
  while ((m = pattern.exec(cleanHtml)) !== null) {
    const timeStr = m[1], mult = parseInt(m[2]);
    if (mult < 50) continue;
    const ts = timeToTimestamp(timeStr, now);
    if (ts < oneHourAgo) continue;
    const seg = cleanHtml.substring(Math.max(0, m.index-50), m.index+200);
    const numM = seg.match(/\b(3[0-6]|[12][0-9]|[0-9])\b/);
    const number = numM ? parseInt(numM[1]) : 0;
    results.push({ numero: number, cor: getColor(number), multiplicador: mult, todosMultiplicadores: [mult], horario: timeStr, timestamp: ts });
  }
  console.log(`Regex amplo: ${results.length}`);
  return deduplicateAndSort(results);
}

async function getData() {
  const now = Date.now();
  if (cache.data.length > 0 && now - cache.lastFetch < cache.ttl) {
    return { source: 'cache', data: cache.data, lastFetch: cache.lastFetch };
  }
  try {
    const html = await fetchTipMiner();
    const parsed = parseRoulette(html);
    cache.data = parsed;
    cache.lastFetch = now;
    console.log(`[${new Date().toISOString()}] ${parsed.length} rodadas encontradas`);
    return { source: 'live', data: parsed, lastFetch: now };
  } catch (err) {
    console.error('Erro:', err.message);
    if (cache.data.length > 0) return { source: 'cache-fallback', data: cache.data, lastFetch: cache.lastFetch };
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/api/roleta' || url === '/') {
    try {
      const result = await getData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, source: result.source, lastFetch: result.lastFetch, total: result.data.length, rodadas: result.data }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url === '/debug') {
    try {
      const html = await fetchTipMiner();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`LENGTH: ${html.length}\n\nFIRST 8000 CHARS:\n${html.substring(0, 8000)}`);
    } catch(err) { res.writeHead(500); res.end(err.message); }
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), cacheSize: cache.data.length }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => console.log(`Rede Sinais Proxy v2 na porta ${PORT}`));
getData().catch(console.error);
