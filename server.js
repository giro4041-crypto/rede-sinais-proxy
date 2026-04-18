/*
  REDE SINAIS — Proxy Server v4
  SSE stream do TipMiner com autenticação por cookie
*/

const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Cookie de sessão do TipMiner (atualizar se expirar)
const SESSION_COOKIE = 'b62fdfc8f6ea5dbc368542bd2556933aee3979f23cda0d887c312f7b81063292%7Cc9bef02446da20ce8e696365dcd57a62991e4e47950ad13f4d4c7ed87690a4b4';

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

let rodadasBuffer = [];
let streamAtivo = false;
let ultimoEvento = 0;
let reconnectTimer = null;
let rawEventosLog = []; // últimos 10 eventos brutos para debug

function limparAntigas() {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  rodadasBuffer = rodadasBuffer.filter(r => r.timestamp > limite);
}

function adicionarRodada(rodada) {
  const existe = rodadasBuffer.find(r => r.horario === rodada.horario);
  if (existe) return;
  rodadasBuffer.unshift(rodada);
  rodadasBuffer.sort((a, b) => b.timestamp - a.timestamp);
  limparAntigas();
  console.log(`Nova rodada: ${rodada.numero} (${rodada.cor}) ${rodada.multiplicador}x @ ${rodada.horario}`);
}

function tsParaHorarioBRT(ts) {
  const d = new Date(ts);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const brt = new Date(utc - 3 * 3600000);
  return String(brt.getHours()).padStart(2,'0') + ':' +
         String(brt.getMinutes()).padStart(2,'0') + ':' +
         String(brt.getSeconds()).padStart(2,'0');
}

function parsearEvento(dataStr) {
  // Guardar log bruto para debug
  rawEventosLog.unshift({ ts: new Date().toISOString(), data: dataStr.substring(0, 500) });
  if (rawEventosLog.length > 10) rawEventosLog.pop();

  try {
    const obj = JSON.parse(dataStr);
    console.log('JSON parsed keys:', Object.keys(obj).join(', '));

    // Extrair número
    const numero = parseInt(
      obj.result ?? obj.number ?? obj.outcome ?? obj.num ??
      obj.winningNumber ?? obj.winning_number ?? obj.slot ?? 0
    );

    // Extrair multiplicadores — múltiplos formatos possíveis
    let multiplicadores = [];

    if (Array.isArray(obj.multipliers)) {
      multiplicadores = obj.multipliers
        .map(m => parseInt(m?.value ?? m?.multiplier ?? m?.mult ?? m) || 0)
        .filter(m => m >= 50);
    }
    if (!multiplicadores.length && Array.isArray(obj.lightning)) {
      multiplicadores = obj.lightning
        .map(m => parseInt(m?.multiplier ?? m?.value ?? m) || 0)
        .filter(m => m >= 50);
    }
    if (!multiplicadores.length && Array.isArray(obj.lightningNumbers)) {
      multiplicadores = obj.lightningNumbers
        .map(m => parseInt(m?.multiplier ?? m?.mult ?? m) || 0)
        .filter(m => m >= 50);
    }
    if (!multiplicadores.length && obj.multiplier && parseInt(obj.multiplier) >= 50) {
      multiplicadores = [parseInt(obj.multiplier)];
    }
    if (!multiplicadores.length && obj.mult && parseInt(obj.mult) >= 50) {
      multiplicadores = [parseInt(obj.mult)];
    }
    if (!multiplicadores.length && obj.maxMultiplier && parseInt(obj.maxMultiplier) >= 50) {
      multiplicadores = [parseInt(obj.maxMultiplier)];
    }

    // Procurar multiplicadores em qualquer campo numérico >= 50
    if (!multiplicadores.length) {
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'number' && val >= 50 && val <= 2000 && key.toLowerCase().includes('mult')) {
          multiplicadores.push(val);
        }
      }
    }

    if (!multiplicadores.length) return null;

    const maxMult = Math.max(...multiplicadores);

    // Extrair timestamp
    let timestamp = Date.now();
    if (obj.createdAt) timestamp = new Date(obj.createdAt).getTime();
    else if (obj.timestamp) timestamp = typeof obj.timestamp === 'number' ? (obj.timestamp < 1e12 ? obj.timestamp * 1000 : obj.timestamp) : new Date(obj.timestamp).getTime();
    else if (obj.time && typeof obj.time === 'string' && !obj.time.match(/^\d{2}:\d{2}/)) timestamp = new Date(obj.time).getTime();
    else if (obj.date) timestamp = new Date(obj.date).getTime();
    else if (obj.startedAt) timestamp = new Date(obj.startedAt).getTime();
    else if (obj.endedAt) timestamp = new Date(obj.endedAt).getTime();

    let horario = '';
    if (obj.time && typeof obj.time === 'string' && obj.time.match(/\d{2}:\d{2}:\d{2}/)) {
      horario = obj.time.match(/(\d{2}:\d{2}:\d{2})/)[1];
    } else {
      horario = tsParaHorarioBRT(timestamp);
    }

    return { numero, cor: getColor(numero), multiplicador: maxMult, todosMultiplicadores: multiplicadores, horario, timestamp };

  } catch(e) {
    // Não é JSON — tentar regex
    const multMatch = dataStr.match(/\b(\d{3,4})x\b/i);
    const timeMatch = dataStr.match(/\b(\d{2}:\d{2}:\d{2})\b/);
    const numMatch = dataStr.match(/"(?:result|number|outcome|slot)"\s*:\s*(\d+)/);

    if (multMatch && parseInt(multMatch[1]) >= 50) {
      const mult = parseInt(multMatch[1]);
      const horario = timeMatch ? timeMatch[1] : tsParaHorarioBRT(Date.now());
      const numero = numMatch ? parseInt(numMatch[1]) : 0;
      const [h, m, s] = horario.split(':').map(Number);
      const now = Date.now();
      const brtNow = new Date(now - 3 * 3600000);
      const d = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate(), h+3, m, s));
      let ts = d.getTime();
      if (ts > now + 60000) ts -= 24*3600000;
      return { numero, cor: getColor(numero), multiplicador: mult, todosMultiplicadores: [mult], horario, timestamp: ts };
    }
    return null;
  }
}

function conectarStream() {
  if (streamAtivo) return;
  streamAtivo = true;
  console.log(`[${new Date().toISOString()}] Conectando ao stream...`);

  const options = {
    hostname: 'www.tipminer.com',
    path: '/stream/rounds/ROULETTE/660ec23b4bf4956ba238491c/v2/live?k=3',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/event-stream',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Referer': 'https://www.tipminer.com/br/historico/evolution/xxxtreme-lightning-roulette',
      'Origin': 'https://www.tipminer.com',
      'Cookie': `session=${SESSION_COOKIE}`,
    }
  };

  const req = https.request(options, (res) => {
    console.log(`Stream HTTP ${res.statusCode}`);
    if (res.statusCode !== 200) {
      console.error('Status inesperado:', res.statusCode);
      streamAtivo = false;
      agendarReconexao(10000);
      return;
    }

    let buffer = '';
    res.on('data', (chunk) => {
      ultimoEvento = Date.now();
      buffer += chunk.toString('utf8');
      const eventos = buffer.split('\n\n');
      buffer = eventos.pop();

      for (const evento of eventos) {
        if (!evento.trim()) continue;
        const linhas = evento.split('\n');
        let tipo = '', dados = '';
        for (const linha of linhas) {
          if (linha.startsWith('event:')) tipo = linha.slice(6).trim();
          else if (linha.startsWith('data:')) dados = linha.slice(5).trim();
        }
        if (!dados || dados === 'ping' || tipo === 'ping') continue;
        console.log(`Evento [${tipo||'?'}]: ${dados.substring(0, 150)}`);
        const rodada = parsearEvento(dados);
        if (rodada) adicionarRodada(rodada);
      }
    });

    res.on('end', () => { console.log('Stream encerrado, reconectando...'); streamAtivo = false; agendarReconexao(); });
    res.on('error', (e) => { console.error('Erro stream:', e.message); streamAtivo = false; agendarReconexao(); });
  });

  req.on('error', (e) => { console.error('Erro conexão:', e.message); streamAtivo = false; agendarReconexao(); });
  req.setTimeout(0);
  req.end();

  // Watchdog 2 min
  setInterval(() => {
    if (streamAtivo && ultimoEvento > 0 && Date.now() - ultimoEvento > 120000) {
      console.log('Watchdog: reconectando...');
      req.destroy();
      streamAtivo = false;
      agendarReconexao();
    }
  }, 30000);
}

function agendarReconexao(delay = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { streamAtivo = false; conectarStream(); }, delay);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/api/roleta' || url === '/') {
    limparAntigas();
    const umaHoraAtras = Date.now() - 60 * 60 * 1000;
    const rodadas = rodadasBuffer.filter(r => r.timestamp > umaHoraAtras);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, source: 'stream', lastFetch: ultimoEvento || Date.now(), total: rodadas.length, streamAtivo, rodadas }));
    return;
  }

  if (url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ streamAtivo, ultimoEvento: ultimoEvento ? new Date(ultimoEvento).toISOString() : null, totalBuffer: rodadasBuffer.length, ultimasRodadas: rodadasBuffer.slice(0,5), rawEventos: rawEventosLog }, null, 2));
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), streamAtivo, totalRodadas: rodadasBuffer.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => { console.log(`Rede Sinais Proxy v4 na porta ${PORT}`); conectarStream(); });
