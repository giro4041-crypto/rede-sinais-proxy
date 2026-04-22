/*
  CRASH SINAIS — Proxy Server
  Conecta ao WebSocket do Weborg e repassa as velas via API REST
*/

const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const WEBORG_TOKEN = 'uN+UYLY2TLjWRajo.DwfEWeg1qyU1CG/F87Koz+BTuvUeOaEyIDcxseTYjO4K/VxUdNTT/EJfmK1sRk19v7LKj10ZbIVUqb0EHbtS1K44d0BKnzX97jAYyVdPONQTKJ7GH5FIqoF5gHBbqY++etMOCST5msYw5XtCt8PxdiRa4c+L4DS/nhRkpa+vyrhGr1sVgMK8n5/VcB0/XMevcDiyULPeR2KL/vPE4gWYOSf6UXB1nhD9djbo';

let velaBuffer = [];
let wsAtivo = false;
let ultimoEvento = 0;
let reconectTimer = null;

function tsParaBRT(ts) {
  const d = new Date(ts);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const brt = new Date(utc - 3 * 3600000);
  return String(brt.getHours()).padStart(2,'0')+':'+
         String(brt.getMinutes()).padStart(2,'0')+':'+
         String(brt.getSeconds()).padStart(2,'0');
}

function adicionarVela(vela) {
  const existe = velaBuffer.find(v => v.id === vela.id);
  if (existe) return;
  velaBuffer.unshift(vela);
  if (velaBuffer.length > 50) velaBuffer.pop();
  console.log(`[${new Date().toISOString()}] Vela: ${vela.mult}x @ ${vela.horario}`);
}

function conectarWeborg() {
  if (wsAtivo) return;
  wsAtivo = true;
  console.log('Conectando ao Weborg WebSocket...');

  const url = `wss://weborg.app.br/ws?room=blaze_crash&auth_token=${encodeURIComponent(WEBORG_TOKEN)}`;
  
  const ws = new WebSocket(url, {
    headers: {
      'Origin': 'https://weborg.app.br',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    }
  });

  ws.on('open', () => {
    console.log('WebSocket conectado ao Weborg!');
    ultimoEvento = Date.now();
  });

  ws.on('message', (data) => {
    ultimoEvento = Date.now();
    try {
      const obj = JSON.parse(data.toString());
      const mult = parseFloat(obj.valorcrash ?? obj.valor ?? obj.multiplicador ?? 0);
      if (!mult || mult < 1) return;

      // Extrair horário completo
      let horario = '';
      if (obj.updated_at) {
        const m = obj.updated_at.match(/(\d{2}:\d{2}:\d{2})/);
        horario = m ? m[1] : tsParaBRT(Date.now());
      } else if (obj.hora_minuto_giro) {
        horario = obj.hora_minuto_giro.length === 5 
          ? obj.hora_minuto_giro + ':00' 
          : obj.hora_minuto_giro;
      } else {
        horario = tsParaBRT(Date.now());
      }

      const vela = {
        id: obj.id ?? obj.crash_id ?? Date.now().toString(),
        mult,
        horario,
        resultado: obj.resultado ?? '',
        ts: Date.now(),
      };

      adicionarVela(vela);
    } catch(e) {
      console.log('Mensagem não-JSON:', data.toString().substring(0,100));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket fechado: ${code} ${reason}`);
    wsAtivo = false;
    agendarReconexao();
  });

  ws.on('error', (err) => {
    console.error('Erro WebSocket:', err.message);
    wsAtivo = false;
    agendarReconexao();
  });

  // Watchdog: sem mensagem por 2min → reconectar
  setInterval(() => {
    if (wsAtivo && ultimoEvento > 0 && Date.now() - ultimoEvento > 120000) {
      console.log('Watchdog: reconectando...');
      ws.terminate();
      wsAtivo = false;
      agendarReconexao();
    }
  }, 30000);
}

function agendarReconexao(delay=5000) {
  if (reconectTimer) clearTimeout(reconectTimer);
  reconectTimer = setTimeout(() => { wsAtivo=false; conectarWeborg(); }, delay);
}

// ---- Servidor HTTP ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/api/velas' || url === '/') {
    // Retornar apenas velas 10x+
    const velasComMult = velaBuffer.filter(v => v.mult >= 10);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      wsAtivo,
      ultimoEvento,
      total: velasComMult.length,
      velas: velasComMult.slice(0, 20),
    }));
    return;
  }

  if (url === '/api/todas') {
    // Retornar todas as velas (para debug)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, total: velaBuffer.length, velas: velaBuffer.slice(0,10) }));
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), wsAtivo, totalVelas: velaBuffer.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Crash Sinais Proxy na porta ${PORT}`);
  conectarWeborg();
});
