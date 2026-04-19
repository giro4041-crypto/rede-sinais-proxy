/*
  REDE SINAIS — Proxy Server v8
  Retorna os últimos 10 resultados com todos os multiplicadores
*/

const https = require('https');
const http = require('http');
const PORT = process.env.PORT || 3000;

const COLOR_MAP = {'Black':'preto','Red':'vermelho','Green':'branco','black':'preto','red':'vermelho','green':'branco'};
const NUM_COLORS = {0:'branco',1:'vermelho',2:'preto',3:'vermelho',4:'preto',5:'vermelho',6:'preto',7:'vermelho',8:'preto',9:'vermelho',10:'preto',11:'preto',12:'vermelho',13:'preto',14:'vermelho',15:'preto',16:'vermelho',17:'preto',18:'vermelho',19:'vermelho',20:'preto',21:'vermelho',22:'preto',23:'vermelho',24:'preto',25:'vermelho',26:'preto',27:'vermelho',28:'preto',29:'preto',30:'vermelho',31:'preto',32:'vermelho',33:'preto',34:'vermelho',35:'preto',36:'vermelho'};

function getColor(colorStr, numero) {
  if (colorStr && COLOR_MAP[colorStr]) return COLOR_MAP[colorStr];
  return NUM_COLORS[parseInt(numero)] || 'branco';
}

let cache = { data: [], lastFetch: 0, ttl: 30000 };

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.casino.org/',
        'Origin': 'https://www.casino.org',
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: null }); }
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
  return String(brt.getHours()).padStart(2,'0')+':'+String(brt.getMinutes()).padStart(2,'0')+':'+String(brt.getSeconds()).padStart(2,'0');
}

function parsearRodada(item) {
  const d = item.data ?? item;
  const outcome = d?.result?.outcome ?? d?.outcome ?? {};
  const numero = parseInt(outcome.number ?? d.number ?? d.result ?? 0);
  const cor = getColor(outcome.color ?? d.color, numero);

  // Buscar APENAS o multiplicador do número que saiu
  const luckyList = d?.result?.luckyNumbersList ?? d?.luckyNumbersList ?? d?.multipliers ?? [];

  // Procurar o multiplicador correspondente ao número sorteado
  const luckyDoNumero = luckyList.find(m => parseInt(m?.number ?? m?.num) === numero);
  let multiplicador = 0;
  if (luckyDoNumero) {
    multiplicador = parseInt(luckyDoNumero?.roundedMultiplier ?? luckyDoNumero?.multiplier ?? luckyDoNumero?.value ?? 0);
  }

  // Se o número sorteado não está na lista de relâmpago, não tem multiplicador especial
  // Mas ainda assim incluímos a rodada com mult=0 para mostrar no histórico
  const todosMultiplicadores = multiplicador > 0 ? [multiplicador] : [];

  // Timestamp
  const timeStr = d?.startedAt ?? d?.settledAt ?? d?.createdAt ?? d?.timestamp;
  const timestamp = timeStr ? new Date(timeStr).getTime() : Date.now();
  const horario = tsParaHorarioBRT(timestamp);

  return { numero, cor, multiplicador, todosMultiplicadores, horario, timestamp };
}

async function getData() {
  const agora = Date.now();
  if (cache.data.length > 0 && agora - cache.lastFetch < cache.ttl) {
    return { source: 'cache', data: cache.data, lastFetch: cache.lastFetch };
  }

  const rodadas = [];
  const seen = new Set();

  // Buscar histórico da última 6h para ter dados suficientes
  const endpoints = [
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/rounds?duration=6',
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/history?duration=6',
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/results?duration=1',
    'https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/list?duration=1',
  ];

  for (const url of endpoints) {
    try {
      const result = await fetchJSON(url);
      if (result.status !== 200 || !result.data) continue;
      const arr = Array.isArray(result.data) ? result.data
        : result.data?.data ?? result.data?.results ?? result.data?.rounds
        ?? result.data?.items ?? result.data?.history ?? [];

      if (arr.length > 0) {
        console.log(`${arr.length} itens em ${url}`);
        for (const item of arr) {
          const r = parsearRodada(item);
          if (!r || seen.has(r.horario)) continue;
          seen.add(r.horario);
          rodadas.push(r);
        }
        if (rodadas.length >= 10) break;
      }
    } catch(e) { console.error(url, e.message); }
  }

  // Se não achou histórico, pegar pelo menos a última rodada
  if (rodadas.length === 0) {
    try {
      const latest = await fetchJSON('https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/latest');
      if (latest.status === 200 && latest.data) {
        const r = parsearRodada(latest.data);
        if (r) rodadas.push(r);
      }
    } catch(e) { console.error('latest:', e.message); }
  }

  rodadas.sort((a, b) => b.timestamp - a.timestamp);
  cache.data = rodadas.slice(0, 20); // guardar 20 no cache
  cache.lastFetch = agora;
  console.log(`[${new Date().toISOString()}] ${rodadas.length} rodadas`);
  return { source: 'live', data: cache.data, lastFetch: agora };
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
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url === '/debug') {
    try {
      const result = await getData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: result.data.length, primeiras3: result.data.slice(0,3) }, null, 2));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), cacheSize: cache.data.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Rede Sinais Proxy v8 na porta ${PORT}`);
  getData().catch(console.error);
});
