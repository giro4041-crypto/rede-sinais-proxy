const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

let sinaisAtivos = [];
let historicoCrash = [];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Origin": "https://blaze.com",
        "Referer": "https://blaze.com/"
      }
    };

    https.get(url, options, (res) => {
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

function gerarSinais({numero, multiplicador, hora, minuto, segundo, dia, mes}) {
  let base = numero.toString().split('').reduce((a,b)=>a+parseInt(b),0) + multiplicador;
  let parcial = base.toString().split('').reduce((a,b)=>a+parseInt(b),0);

  let tempo = parcial + hora + minuto + segundo;
  let dataFinal = tempo + dia + mes;

  return [
    dataFinal % 60,
    (dataFinal + 7) % 60,
    (dataFinal + 34) % 60,
    (dataFinal + 27) % 60
  ];
}

function dentroDaJanela() {
  const agora = new Date();
  return sinaisAtivos.includes(agora.getMinutes()) && agora.getSeconds() <= 10;
}

function detectar10x() {
  const ultimos = historicoCrash.slice(-20);
  return ultimos.filter(x => x < 2).length >= 7 &&
         ultimos.filter(x => x >= 10).length === 0;
}

function filtroForte() {
  const ultimos = historicoCrash.slice(-10);
  return ultimos.filter(x => x < 2).length >= 5 &&
         ultimos.filter(x => x >= 5).length <= 1;
}

function verificarEntrada() {
  return sinaisAtivos.length && dentroDaJanela() && detectar10x() && filtroForte();
}

async function atualizarRoleta() {
  try {
    const data = await fetchJSON(
      "https://api-cs.casino.org/svc-evolution-game-events/api/xxxtremelightningroulette/latest"
    );

    if (!data) return;

    const item = Array.isArray(data) ? data[0] : data;

    const numero = item?.result?.outcome?.number || 0;
    const multiplicador = item?.result?.luckyNumbersList?.[0]?.multiplier || 0;

    const d = new Date(item.settledAt || Date.now());

    sinaisAtivos = gerarSinais({
      numero,
      multiplicador,
      hora: d.getHours(),
      minuto: d.getMinutes(),
      segundo: d.getSeconds(),
      dia: d.getDate(),
      mes: d.getMonth() + 1
    });

    console.log("🎯", sinaisAtivos);

  } catch {}
}

async function atualizarCrash() {
  try {
    const data = await fetchJSON("https://api-v2.blaze.com/crash_games/recent");

    if (!data) return;

    const novos = data.map(x => parseFloat(x.crash_point)).filter(x => !isNaN(x));

    historicoCrash = [...historicoCrash, ...novos].slice(-50);

    console.log("💥", historicoCrash.length);

  } catch {}
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === "/api/painel") {
    return res.end(JSON.stringify({
      sinais: sinaisAtivos,
      entrada: verificarEntrada(),
      historico: historicoCrash.slice(-20)
    }));
  }

  if (req.url === "/health") {
    return res.end(JSON.stringify({ ok: true }));
  }

  res.end(JSON.stringify({ ok: true }));
});

setInterval(atualizarRoleta, 5000);
setInterval(atualizarCrash, 5000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 rodando", PORT);
});
