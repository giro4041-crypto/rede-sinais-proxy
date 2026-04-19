/*
  REDE SINAIS — Proxy Server v6
  Chama direto a API do casino.org
*/

const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

const ROULETTE_COLORS = {
  0:'branco',1:'vermelho',2:'preto',3:'vermelho',4:'preto',5:'vermelho',
  6:'preto',7:'vermelho',8:'preto',9:'vermelho',10:'preto',
  11:'preto',12:'vermelho',13:'preto',14:'vermelho',15:'preto',
  16:'vermelho',17:'preto',18:'vermelho',19:'vermelho',20:'preto',
  21:'vermelho',22:'preto',23:'vermelho',24:'preto',25:'vermelho',
  26:'preto',27:'vermelho',28:'preto',29:'preto',30:'vermelho',
  31:'preto',32:'vermelho',33:'preto',34:'vermelho',35:'preto',36:'vermelho',
};

function getColor(n) { return ROULETTE_COLORS[parseInt(n)] || 'branco'; }

let cache = { data: [], lastFetch: 0, ttl: 30000 };

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://www.casino.org/',
        'Origin': 'https://www.casino.org',
      }
    };
    const req = https.get(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`GET ${url} → ${res.statusCode} (${body.length} chars)`);
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: null, raw: body.substring(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function tsParaHorarioBRT(ts) {
  const d = new Date(ts);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const brt = new Date(utc - 3 * 3600000);
  return String(brt.getHours()).padStart(2,'0') + ':' +
         String(brt.getMinutes()).padStart(2,'0') + ':' +
         String(brt.getSeconds()).padStart(2,'0');
}

function parsearRodadas(data) {
  const agora = Date.now();
  const umaHoraAtras = agora - 60 * 60 * 1000;
  const resultados = [];

  // Normalizar para array
  const arr = Array.isArray(data) ? data
    : data?.data ?? data?.results ?? data?.rounds
    ?? data?.spins ?? data?.history ?? data?.items ?? [];

  console.log(`Parseando ${arr.length} itens...`);

  for (const item of arr) {
    if (typeof item !== 'object') continue;

    // Extrair número
    const numero = parseInt(
      item.result ?? item.number ?? item.outcome ??
      item.winningNumber ?? item.winning_number ??
      item.slot ?? item.num ?? 0
    );

    // Extrair multiplicadores
    let multiplicadores = [];
    if (Array.isArray(item.multipliers)) {
      multiplicadores = item.multipliers
        .map(m => parseInt(m?.value ?? m?.multiplier ?? m?.mult ?? m) || 0)
        .filter(m => m >= 50);
    }
    if (!multiplicadores.length && Array.isArray(item.lightningNumbers)) {
      multiplicadores = item.lightningNumbers
        .map(m => parseInt(m?.multiplier ?? m?.value ?? m?.mult ?? m) || 0)
        .filter(m => m >= 50);
    }
    if (!multiplicadores.length && Array.isArray(item.lightning)) {
      multiplicadores = item.lightning
        .map(m => parseInt(m?.multiplier ?? m?.value ?? m) || 0)
        .filter(m => m >= 50);
    }
    if (!multiplicadores.length && item.multiplier && parseInt(item.multiplier) >= 50) {
      multiplicadores = [parseInt(item.multiplier)];
    }
    if (!multiplicadores.length && item.maxMultiplier && parseInt(item.maxMultiplier) >= 50) {
      multiplicadores = [parseInt(item.maxMultiplier)];
    }
    if (!multiplicadores.length && item.topMultiplier && parseInt(item.topMultiplier) >= 50) {
      multiplicadores = [parseInt(item.topMultiplier)];
    }

    // Só incluir rodadas COM multiplicador
    if (!multiplicadores.length) continue;

    // Extrair timestamp
    let timestamp = agora;
    const timeVal = item.timestamp ?? item.createdAt ?? item.created_at ??
                    item.time ?? item.date ?? item.startedAt ?? item.endedAt;

    if (timeVal) {
      if (typeof timeVal === 'number') {
        timestamp = timeVal < 1e12 ? timeVal * 1000 : timeVal;
      } else {
        timestamp = new Date(timeVal).getTime();
      }
    }

    if (timestamp < umaHoraAtras) continue;

    const horario = tsParaHorarioBRT(timestamp);
    const maxMult = Math.max(...multiplicadores);

    resultados.push({
      numero,
      cor: getColor(numero),
      multiplicador: maxMult,
      todosMultiplicadores: multiplicadores,
      horario,
      timestamp,
    });
  }

  // Remover duplicatas e ordenar
  const seen = new Set();
  return resultados
    .filter(r => { if (seen.has(r.horario)) return false; seen.add(r.horario); return true; })
    .sort((a, b) => b.timestamp - a.timestamp);
}

async function getData() {
  const agora = Date.now();
  if (cache.data.length > 0 && agora - cache.lastFetch < cache.ttl) {
    return { source: 'cache', data: cache.data, lastFetch: cache.lastFetch };
  }

  // Tentar os endpoints capturados pelo Puppeteer
  const endpoints = [
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/latest',
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/stats?duration=1',
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/stats?duration=6',
  ];

  for (const url of endpoints) {
    try {
      const result = await fetchJSON(url);
      if (result.status === 200 && result.data) {
        console.log('Resposta de', url, ':', JSON.stringify(result.data).substring(0, 300));
        const rodadas = parsearRodadas(result.data);
        if (rodadas.length > 0) {
          cache.data = rodadas;
          cache.lastFetch = agora;
          console.log(`[${new Date().toISOString()}] ${rodadas.length} rodadas encontradas via ${url}`);
          return { source: 'live', data: rodadas, lastFetch: agora };
        }
      }
    } catch(e) {
      console.error('Erro em', url, ':', e.message);
    }
  }

  // Nenhum endpoint retornou dados
  console.log('Nenhum endpoint retornou rodadas com multiplicador');
  cache.lastFetch = agora;
  return { source: 'live', data: [], lastFetch: agora };
}

// ---- Servidor ----
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
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Debug — mostra resposta bruta das APIs
  if (url === '/debug') {
    try {
      const endpoints = [
        'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/latest',
        'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/stats?duration=1',
      ];
      const results = {};
      for (const ep of endpoints) {
        try {
          const r = await fetchJSON(ep);
          results[ep] = { status: r.status, preview: JSON.stringify(r.data ?? r.raw).substring(0, 500) };
        } catch(e) {
          results[ep] = { error: e.message };
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(results, null, 2));
    } catch(e) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), cacheSize: cache.data.length, lastFetch: cache.lastFetch }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Rede Sinais Proxy v6 na porta ${PORT}`);
  getData().catch(console.error);
});
