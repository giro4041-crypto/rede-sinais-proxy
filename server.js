/*
  REDE SINAIS — Proxy Server v3
  Consome o SSE stream do TipMiner em tempo real
  URL: /stream/rounds/ROULETTE/660ec23b4bf4956ba238491c/v2/live?k=3
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

// ---- Buffer de rodadas (últimas 2h para garantir 1h disponível) ----
let rodadasBuffer = [];
let streamAtivo = false;
let ultimoEvento = 0;
let reconnectTimer = null;

function limparAntigas() {
  const umaHoraAtras = Date.now() - 2 * 60 * 60 * 1000;
  rodadasBuffer = rodadasBuffer.filter(r => r.timestamp > umaHoraAtras);
}

function adicionarRodada(rodada) {
  // Evitar duplicatas por horário
  const existe = rodadasBuffer.find(r => r.horario === rodada.horario);
  if (existe) return;
  rodadasBuffer.unshift(rodada);
  rodadasBuffer.sort((a, b) => b.timestamp - a.timestamp);
  limparAntigas();
  console.log(`[${new Date().toISOString()}] Nova rodada: ${rodada.numero} (${rodada.cor}) mult: ${rodada.multiplicador}x @ ${rodada.horario}`);
}

function parsearEvento(dataStr) {
  try {
    // O stream envia JSON com dados da rodada
    const obj = JSON.parse(dataStr);

    // Extrair número da roleta
    const numero = parseInt(
      obj.result ?? obj.number ?? obj.outcome ?? obj.num ?? obj.n ?? 0
    );

    // Extrair multiplicadores — pode vir em vários formatos
    let multiplicadores = [];
    if (obj.multipliers && Array.isArray(obj.multipliers)) {
      multiplicadores = obj.multipliers.map(m => parseInt(m.value ?? m.multiplier ?? m) || 0).filter(m => m >= 50);
    } else if (obj.lightning && Array.isArray(obj.lightning)) {
      multiplicadores = obj.lightning.map(m => parseInt(m.multiplier ?? m.value ?? m) || 0).filter(m => m >= 50);
    } else if (obj.multiplier && parseInt(obj.multiplier) >= 50) {
      multiplicadores = [parseInt(obj.multiplier)];
    } else if (obj.mult && parseInt(obj.mult) >= 50) {
      multiplicadores = [parseInt(obj.mult)];
    }

    // Só processar rodadas COM multiplicador
    if (multiplicadores.length === 0) return null;

    const maxMult = Math.max(...multiplicadores);

    // Extrair horário
    let timestamp = Date.now();
    let horario = '';

    if (obj.createdAt) {
      timestamp = new Date(obj.createdAt).getTime();
    } else if (obj.timestamp) {
      timestamp = typeof obj.timestamp === 'number'
        ? (obj.timestamp < 1e12 ? obj.timestamp * 1000 : obj.timestamp)
        : new Date(obj.timestamp).getTime();
    } else if (obj.time) {
      if (typeof obj.time === 'string' && obj.time.match(/\d{2}:\d{2}:\d{2}/)) {
        horario = obj.time;
      } else {
        timestamp = new Date(obj.time).getTime();
      }
    } else if (obj.date) {
      timestamp = new Date(obj.date).getTime();
    }

    if (!horario) {
      // Converter timestamp UTC para BRT (UTC-3)
      const d = new Date(timestamp);
      const utc = d.getTime() + d.getTimezoneOffset() * 60000;
      const brt = new Date(utc - 3 * 3600000);
      horario = String(brt.getHours()).padStart(2,'0') + ':' +
                String(brt.getMinutes()).padStart(2,'0') + ':' +
                String(brt.getSeconds()).padStart(2,'0');
    }

    return {
      numero,
      cor: getColor(numero),
      multiplicador: maxMult,
      todosMultiplicadores: multiplicadores,
      horario,
      timestamp,
      raw: obj, // para debug
    };

  } catch(e) {
    // Tentar extrair dados com regex se JSON falhar
    const multMatch = dataStr.match(/(\d{3,4})x/i);
    const timeMatch = dataStr.match(/(\d{2}:\d{2}:\d{2})/);
    if (multMatch && timeMatch && parseInt(multMatch[1]) >= 50) {
      const horario = timeMatch[1];
      const mult = parseInt(multMatch[1]);
      const [h, m, s] = horario.split(':').map(Number);
      const now = Date.now();
      const brtNow = new Date(now - 3 * 3600000);
      const d = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate(), h+3, m, s));
      let ts = d.getTime();
      if (ts > now + 60000) ts -= 24*3600000;
      return { numero: 0, cor: 'branco', multiplicador: mult, todosMultiplicadores: [mult], horario, timestamp: ts };
    }
    return null;
  }
}

// ---- Conectar ao SSE stream do TipMiner ----
function conectarStream() {
  if (streamAtivo) return;
  streamAtivo = true;
  console.log(`[${new Date().toISOString()}] Conectando ao stream do TipMiner...`);

  const options = {
    hostname: 'www.tipminer.com',
    path: '/stream/rounds/ROULETTE/660ec23b4bf4956ba238491c/v2/live?k=3',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/event-stream',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.tipminer.com/br/historico/evolution/xxxtreme-lightning-roulette',
      'Origin': 'https://www.tipminer.com',
    }
  };

  const req = https.request(options, (res) => {
    console.log(`Stream conectado: HTTP ${res.statusCode}`);

    if (res.statusCode !== 200) {
      console.error('Stream retornou status inesperado:', res.statusCode);
      streamAtivo = false;
      agendarReconexao();
      return;
    }

    let buffer = '';

    res.on('data', (chunk) => {
      ultimoEvento = Date.now();
      buffer += chunk.toString('utf8');

      // Processar eventos SSE (separados por \n\n)
      const eventos = buffer.split('\n\n');
      buffer = eventos.pop(); // último pode estar incompleto

      for (const evento of eventos) {
        if (!evento.trim()) continue;

        const linhas = evento.split('\n');
        let tipo = '';
        let dados = '';

        for (const linha of linhas) {
          if (linha.startsWith('event:')) {
            tipo = linha.slice(6).trim();
          } else if (linha.startsWith('data:')) {
            dados = linha.slice(5).trim();
          }
        }

        if (tipo === 'ping') continue; // ignorar pings
        console.log('RAW EVENTO:', JSON.stringify({tipo, dados: dados.substring(0, 300)}));

        if (dados && dados !== 'ping') {
          console.log(`Evento: ${tipo || 'update'} | dados: ${dados.substring(0, 100)}`);
          const rodada = parsearEvento(dados);
          if (rodada) adicionarRodada(rodada);
        }
      }
    });

    res.on('end', () => {
      console.log('Stream encerrado pelo servidor. Reconectando...');
      streamAtivo = false;
      agendarReconexao();
    });

    res.on('error', (err) => {
      console.error('Erro no stream:', err.message);
      streamAtivo = false;
      agendarReconexao();
    });
  });

  req.on('error', (err) => {
    console.error('Erro ao conectar stream:', err.message);
    streamAtivo = false;
    agendarReconexao();
  });

  req.setTimeout(0); // sem timeout — é stream contínuo
  req.end();

  // Watchdog: se não receber nada em 2 minutos, reconectar
  setInterval(() => {
    if (streamAtivo && ultimoEvento > 0 && Date.now() - ultimoEvento > 120000) {
      console.log('Watchdog: stream inativo por 2min, reconectando...');
      req.destroy();
      streamAtivo = false;
      agendarReconexao();
    }
  }, 30000);
}

function agendarReconexao(delay = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    streamAtivo = false;
    conectarStream();
  }, delay);
}

// ---- Servidor HTTP ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/api/roleta' || url === '/') {
    limparAntigas();
    const umaHoraAtras = Date.now() - 60 * 60 * 1000;
    const rodadasUltimaHora = rodadasBuffer.filter(r => r.timestamp > umaHoraAtras);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      source: 'stream',
      lastFetch: ultimoEvento || Date.now(),
      total: rodadasUltimaHora.length,
      streamAtivo,
      rodadas: rodadasUltimaHora,
    }));
    return;
  }

  if (url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      streamAtivo,
      ultimoEvento: ultimoEvento ? new Date(ultimoEvento).toISOString() : null,
      totalBuffer: rodadasBuffer.length,
      ultimasRodadas: rodadasBuffer.slice(0, 5),
    }, null, 2));
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

server.listen(PORT, () => {
  console.log(`Rede Sinais Proxy v3 na porta ${PORT}`);
  conectarStream();
});
