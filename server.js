/*
  ============================================================
  REDE SINAIS — Proxy Server
  Faz scraping do TipMiner e disponibiliza os dados via API

  DEPLOY NO RAILWAY (gratuito):
  1. Crie conta em https://railway.app (login com GitHub)
  2. "New Project" → "Deploy from GitHub repo"
  3. Faça upload deste projeto no GitHub (ou use Railway CLI)
  4. Railway detecta automaticamente o Node.js e faz deploy
  5. Vá em Settings → Networking → Generate Domain
  6. Copie a URL gerada (ex: https://rede-sinais.up.railway.app)
  7. Cole essa URL no HTML da calculadora onde indicado
  ============================================================
*/

const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Cache dos dados para não sobrecarregar o TipMiner
let cache = {
  data: [],
  lastFetch: 0,
  ttl: 30000, // 30 segundos
};

// ---- Cores da roleta ----
const ROULETTE_COLORS = {
  0: 'branco',
  1: 'vermelho', 2: 'preto', 3: 'vermelho', 4: 'preto', 5: 'vermelho',
  6: 'preto', 7: 'vermelho', 8: 'preto', 9: 'vermelho', 10: 'preto',
  11: 'preto', 12: 'vermelho', 13: 'preto', 14: 'vermelho', 15: 'preto',
  16: 'vermelho', 17: 'preto', 18: 'vermelho', 19: 'vermelho', 20: 'preto',
  21: 'vermelho', 22: 'preto', 23: 'vermelho', 24: 'preto', 25: 'vermelho',
  26: 'preto', 27: 'vermelho', 28: 'preto', 29: 'preto', 30: 'vermelho',
  31: 'preto', 32: 'vermelho', 33: 'preto', 34: 'vermelho', 35: 'preto',
  36: 'vermelho',
};

function getColor(number) {
  return ROULETTE_COLORS[number] || 'branco';
}

// ---- Buscar dados do TipMiner ----
function fetchTipMiner() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.tipminer.com',
      path: '/br/historico/evolution/xxxtreme-lightning-roulette',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cache-Control': 'no-cache',
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ---- Parser do HTML do TipMiner ----
function parseRoulette(html) {
  const results = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Busca blocos de rodadas — padrão do TipMiner
  // Cada rodada tem número, multiplicador e horário
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    // Extrair horário
    const timeMatch = row.match(/(\d{2}:\d{2}:\d{2})/);
    if (!timeMatch) continue;
    const timeStr = timeMatch[1];

    // Construir timestamp de hoje com esse horário (em BRT UTC-3)
    const [h, m, s] = timeStr.split(':').map(Number);
    const brtNow = new Date(now - 3 * 3600000); // UTC-3
    const brtDate = new Date(brtNow);
    brtDate.setUTCHours(h + 3, m, s, 0); // converter BRT → UTC
    let ts = brtDate.getTime();
    // Se o horário for "futuro" (ex: virada de dia), subtrair 24h
    if (ts > now + 60000) ts -= 24 * 3600000;

    // Só últimas 1h
    if (ts < oneHourAgo) continue;

    // Extrair número da roleta
    const numMatch = row.match(/\b([0-9]|[1-2][0-9]|3[0-6]|0)\b/);
    if (!numMatch) continue;
    const number = parseInt(numMatch[1]);

    // Extrair multiplicador (ex: 50x, 100x, 500x, 2000x)
    const multMatches = row.match(/(\d{2,4})x/gi);
    const multipliers = multMatches ? multMatches.map(m => parseInt(m)) : [];
    const maxMult = multipliers.length > 0 ? Math.max(...multipliers) : null;

    // Só incluir rodadas COM multiplicador
    if (!maxMult) continue;

    const color = getColor(number);

    results.push({
      numero: number,
      cor: color,
      multiplicador: maxMult,
      todosMultiplicadores: multipliers,
      horario: timeStr,
      timestamp: ts,
    });
  }

  // Caso o parser acima não funcione (site muda estrutura),
  // tenta abordagem alternativa com regex mais amplo
  if (results.length === 0) {
    const altRegex = /(\d{2}:\d{2}:\d{2})[\s\S]{0,300}?(\d{2,4})x/gi;
    let match;
    while ((match = altRegex.exec(html)) !== null) {
      const timeStr = match[1];
      const mult = parseInt(match[2]);
      if (mult < 50) continue; // ignora multiplicadores baixos da roleta

      const [h, m, s] = timeStr.split(':').map(Number);
      const brtNow = new Date(now - 3 * 3600000);
      const brtDate = new Date(brtNow);
      brtDate.setUTCHours(h + 3, m, s, 0);
      let ts = brtDate.getTime();
      if (ts > now + 60000) ts -= 24 * 3600000;
      if (ts < oneHourAgo) continue;

      // Tentar extrair número próximo ao match
      const segment = html.substring(Math.max(0, match.index - 200), match.index + 200);
      const numMatch = segment.match(/\b(3[0-6]|[1-2][0-9]|[0-9])\b/);
      const number = numMatch ? parseInt(numMatch[1]) : 0;
      const color = getColor(number);

      results.push({
        numero: number,
        cor: color,
        multiplicador: mult,
        todosMultiplicadores: [mult],
        horario: timeStr,
        timestamp: ts,
      });
    }
  }

  // Ordenar por horário mais recente
  results.sort((a, b) => b.timestamp - a.timestamp);

  // Remover duplicatas por horário
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.horario)) return false;
    seen.add(r.horario);
    return true;
  });
}

// ---- Obter dados (com cache) ----
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
    console.log(`[${new Date().toISOString()}] Fetched ${parsed.length} rodadas com multiplicador`);
    return { source: 'live', data: parsed, lastFetch: now };
  } catch (err) {
    console.error('Erro ao buscar TipMiner:', err.message);
    if (cache.data.length > 0) {
      return { source: 'cache-fallback', data: cache.data, lastFetch: cache.lastFetch };
    }
    throw err;
  }
}

// ---- Servidor HTTP ----
const server = http.createServer(async (req, res) => {
  // CORS — permite qualquer origem (necessário para o HTML chamar a API)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // GET /api/roleta — retorna rodadas com multiplicador da última 1h
  if (url === '/api/roleta' || url === '/') {
    try {
      const result = await getData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        source: result.source,
        lastFetch: result.lastFetch,
        total: result.data.length,
        rodadas: result.data,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // GET /health — healthcheck
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Rota não encontrada' }));
});

server.listen(PORT, () => {
  console.log(`Rede Sinais Proxy rodando na porta ${PORT}`);
});

// Pré-fetch ao iniciar
getData().catch(console.error);
