/*
  REDE SINAIS — Proxy Server v10 (com sinais + motor)
*/

const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ================= VARIÁVEIS =================

let cache = { data: [], lastFetch: 0, ttl: 30000 };

let ultimoEventoRoleta = null;
let sinaisAtivos = [];
let historicoCrash = []; // você pode integrar depois com seu Python se quiser

// ================= HELPERS =================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {}, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
  });
}

function tsParaHorarioBRT(ts) {
  const d = new Date(ts);
  return {
    hora: d.getHours(),
    minuto: d.getMinutes(),
    segundo: d.getSeconds(),
    dia: d.getDate(),
    mes: d.getMonth() + 1
  };
}

// ================= ROLETA =================

function gerarSinais(dados) {
  const { numero, multiplicador, hora, minuto, segundo, dia, mes } = dados;

  let base = numero.toString().split('').reduce((a,b)=>a+parseInt(b),0) + multiplicador;
  let parcial = base.toString().split('').reduce((a,b)=>a+parseInt(b),0);
  let tempo = parcial + (hora+minuto+segundo);
  let data = tempo + (dia+mes);

  return [
    data % 60,
    (data + 7) % 60,
    (data + 34) % 60,
    (data + 27) % 60 // ajuste extra
  ];
}

// ================= FILTROS =================

function dentroDaJanela() {
  const agora = new Date();
  return sinaisAtivos.includes(agora.getMinutes()) && agora.getSeconds() <= 10;
}

function detectar10x() {
  const ultimos = historicoCrash.slice(-20);

  const abaixo2 = ultimos.filter(x => x < 2).length;
  const acima10 = ultimos.filter(x => x >= 10).length;

  return abaixo2 >= 7 && acima10 === 0;
}

function filtroForte() {
  const ultimos = historicoCrash.slice(-10);

  const abaixo2 = ultimos.filter(x => x < 2).length;
  const acima5 = ultimos.filter(x => x >= 5).length;

  return abaixo2 >= 5 && acima5 <= 1;
}

function verificarEntrada() {
  if (!sinaisAtivos.length) return false;

  if (dentroDaJanela() && detectar10x() && filtroForte()) {
    return true;
  }

  return false;
}

// ================= PARSE ROLETA =================

function parsearRodada(item) {
  const numero = item.result?.outcome?.number || item.number || 0;
  const multiplicador = item.result?.luckyNumbersList?.[0]?.multiplier || 0;

  const ts = new Date(item.settledAt || Date.now()).getTime();
  const tempo = tsParaHorarioBRT(ts);

  const dados = {
    numero,
    multiplicador,
    ...tempo
  };

  ultimoEventoRoleta = dados;
  sinaisAtivos = gerarSinais(dados);

  console.log("🎯 SINAIS:", sinaisAtivos);

  return dados;
}

// ================= BUSCA =================

async function getData() {
  const agora = Date.now();

  if (cache.data.length > 0 && agora - cache.lastFetch < cache.ttl) {
    return cache.data;
  }

  try {
    const data = await fetchJSON(
      "https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/latest"
    );

    if (data) {
      parsearRodada(data);
      cache.data = [data];
      cache.lastFetch = agora;
    }
  } catch (e) {
    console.log("Erro fetch:", e.message);
  }

  return cache.data;
}

// ================= SERVER =================

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === "/api/roleta") {
    const data = await getData();

    res.end(JSON.stringify({
      ok: true,
      sinais: sinaisAtivos,
      roleta: ultimoEventoRoleta
    }));
    return;
  }

  if (req.url === "/api/painel") {
    res.end(JSON.stringify({
      sinais: sinaisAtivos,
      entrada: verificarEntrada(),
      historico: historicoCrash.slice(-10)
    }));
    return;
  }

  if (req.url === "/health") {
    res.end(JSON.stringify({
      ok: true,
      sinais: sinaisAtivos.length
    }));
    return;
  }

  res.end("OK");
});

// ================= LOOP =================

setInterval(() => {
  getData();
}, 5000);

server.listen(PORT, () => {
  console.log("🚀 Server rodando na porta", PORT);
});
