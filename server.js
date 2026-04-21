const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ================= ESTADO =================

let sinaisAtivos = [];
let historicoCrash = [];

// ================= HELPERS =================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

function tsParaHorario(ts) {
  const d = new Date(ts);
  return {
    hora: d.getHours(),
    minuto: d.getMinutes(),
    segundo: d.getSeconds(),
    dia: d.getDate(),
    mes: d.getMonth() + 1
  };
}

// ================= SINAIS =================

function gerarSinais(dados) {
  const { numero, multiplicador, hora, minuto, segundo, dia, mes } = dados;

  let base = numero.toString().split('').reduce((a,b)=>a+parseInt(b),0) + multiplicador;
  let parcial = base.toString().split('').reduce((a,b)=>a+parseInt(b),0);

  let tempo = parcial + (hora || 0) + (minuto || 0) + (segundo || 0);
  let dataFinal = tempo + (dia || 0) + (mes || 0);

  return [
    dataFinal % 60,
    (dataFinal + 7) % 60,
    (dataFinal + 34) % 60,
    (dataFinal + 27) % 60
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
  return sinaisAtivos.length && dentroDaJanela() && detectar10x() && filtroForte();
}

// ================= ROLETA =================

async function atualizarRoleta() {
  try {
    const data = await fetchJSON(
      "https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/latest"
    );

    if (!data) return;

    const item = Array.isArray(data) ? data[0] : data;

    const numero = item?.result?.outcome?.number || item?.number || 0;
    const multiplicador = item?.result?.luckyNumbersList?.[0]?.multiplier || 0;

    const ts = new Date(item.settledAt || Date.now()).getTime();
    const tempo = tsParaHorario(ts);

    const dados = {
      numero,
      multiplicador,
      ...tempo
    };

    sinaisAtivos = gerarSinais(dados);

    console.log("🎯 SINAIS:", sinaisAtivos);

  } catch (e) {
    console.log("Erro roleta:", e.message);
  }
}

// ================= CRASH (API ESTÁVEL) =================

async function atualizarCrash() {
  try {
    const data = await fetchJSON("https://blaze.com/api/crash_games/recent");

    if (!data) return;

    data.forEach(item => {
      const crash = parseFloat(item.crash_point);

      if (!isNaN(crash)) {
        historicoCrash.push(crash);
      }
    });

    // mantém só últimos 50
    historicoCrash = historicoCrash.slice(-50);

    console.log("💥 HISTÓRICO:", historicoCrash.length);

  } catch (e) {
    console.log("Erro crash:", e.message);
  }
}

// ================= SERVER =================

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {

    if (req.url === "/api/painel") {
      res.end(JSON.stringify({
        sinais: sinaisAtivos,
        entrada: verificarEntrada(),
        historico: historicoCrash.slice(-20)
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

    res.end(JSON.stringify({ ok: true }));

  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ erro: e.message }));
  }
});

// ================= LOOP =================

setInterval(atualizarRoleta, 5000);
setInterval(atualizarCrash, 5000);

// ================= START =================

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server rodando na porta", PORT);
});
