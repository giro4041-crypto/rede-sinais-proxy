/*
  REDE SINAIS — Proxy Server v5 (Puppeteer)
  Abre o casino.org com Chrome headless e extrai os dados renderizados
*/

const http = require('http');
const puppeteer = require('puppeteer');

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
let browser = null;
let buscando = false;

// ---- Iniciar browser ----
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('Iniciando Puppeteer...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ]
  });
  console.log('Puppeteer iniciado!');
  return browser;
}

// ---- Buscar dados com Puppeteer ----
async function fetchComPuppeteer() {
  if (buscando) return cache.data;
  buscando = true;

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Bloquear recursos desnecessários para ser mais rápido
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const tipo = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(tipo)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Interceptar chamadas de API para capturar dados JSON diretamente
    let apiData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/') || url.includes('spins') || url.includes('rounds') || url.includes('history')) {
        try {
          const text = await response.text();
          if (text.startsWith('[') || text.startsWith('{')) {
            console.log('API capturada:', url);
            apiData = JSON.parse(text);
          }
        } catch(e) {}
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log('Abrindo casino.org...');
    await page.goto('https://www.casino.org/casinoscores/pt-br/xxxtreme-lightning-roulette/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Aguardar tabela de histórico carregar
    await page.waitForSelector('table, [class*="spin"], [class*="round"], [class*="history"], [class*="result"]', {
      timeout: 15000
    }).catch(() => console.log('Seletor não encontrado, tentando extrair mesmo assim...'));

    // Aguardar mais um pouco para dados renderizarem
    await new Promise(r => setTimeout(r, 3000));

    // Se capturou dados via API, usar eles
    if (apiData) {
      console.log('Usando dados da API interceptada');
      buscando = false;
      return parsearApiData(apiData);
    }

    // Extrair dados do DOM renderizado
    const rodadas = await page.evaluate(() => {
      const resultados = [];
      const agora = Date.now();
      const umaHoraAtras = agora - 60 * 60 * 1000;

      // Tentar encontrar linhas de tabela com dados de rodadas
      const seletores = [
        'table tbody tr',
        '[class*="spin-row"]',
        '[class*="round-row"]',
        '[class*="history-row"]',
        '[class*="result-row"]',
        '[class*="SpinRow"]',
        '[class*="RoundRow"]',
      ];

      let linhas = [];
      for (const sel of seletores) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) { linhas = Array.from(els); break; }
      }

      for (const linha of linhas) {
        const texto = linha.innerText || linha.textContent || '';
        if (!texto.trim()) continue;

        // Extrair horário
        const timeMatch = texto.match(/(\d{2}:\d{2}:\d{2})/);
        if (!timeMatch) continue;
        const horario = timeMatch[1];

        // Extrair multiplicador
        const multMatches = texto.match(/(\d{2,4})x/gi);
        if (!multMatches) continue;
        const multiplicadores = multMatches.map(m => parseInt(m)).filter(m => m >= 50);
        if (!multiplicadores.length) continue;

        // Extrair número da roleta (0-36)
        const numMatch = texto.match(/\b(3[0-6]|[12][0-9]|[0-9])\b/);
        const numero = numMatch ? parseInt(numMatch[1]) : 0;

        resultados.push({ horario, numero, multiplicador: Math.max(...multiplicadores), multiplicadores });
      }

      return resultados;
    });

    console.log(`Extraídas ${rodadas.length} rodadas do DOM`);

    // Se não achou no DOM, tentar pegar texto completo e parsear
    if (rodadas.length === 0) {
      const textoCompleto = await page.evaluate(() => document.body.innerText);
      console.log('Texto página (500 chars):', textoCompleto.substring(0, 500));

      // Salvar HTML para debug
      const htmlCompleto = await page.content();
      console.log('HTML length:', htmlCompleto.length);
    }

    await page.close();
    buscando = false;
    return processarRodadas(rodadas);

  } catch(err) {
    console.error('Erro Puppeteer:', err.message);
    if (page) await page.close().catch(() => {});
    buscando = false;
    throw err;
  }
}

function parsearApiData(data) {
  const resultados = [];
  const agora = Date.now();
  const umaHoraAtras = agora - 60 * 60 * 1000;

  const arr = Array.isArray(data) ? data : (data.data || data.results || data.rounds || data.spins || []);

  for (const item of arr) {
    const numero = parseInt(item.result ?? item.number ?? item.outcome ?? item.winningNumber ?? 0);
    let multiplicadores = [];

    if (Array.isArray(item.multipliers)) multiplicadores = item.multipliers.map(m => parseInt(m.value ?? m.multiplier ?? m) || 0).filter(m => m >= 50);
    else if (item.multiplier && parseInt(item.multiplier) >= 50) multiplicadores = [parseInt(item.multiplier)];
    else if (item.maxMultiplier && parseInt(item.maxMultiplier) >= 50) multiplicadores = [parseInt(item.maxMultiplier)];

    if (!multiplicadores.length) continue;

    let timestamp = agora;
    if (item.timestamp) timestamp = typeof item.timestamp === 'number' ? (item.timestamp < 1e12 ? item.timestamp * 1000 : item.timestamp) : new Date(item.timestamp).getTime();
    else if (item.createdAt) timestamp = new Date(item.createdAt).getTime();
    else if (item.time) timestamp = new Date(item.time).getTime();

    if (timestamp < umaHoraAtras) continue;

    const d = new Date(timestamp);
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    const brt = new Date(utc - 3 * 3600000);
    const horario = String(brt.getHours()).padStart(2,'0') + ':' + String(brt.getMinutes()).padStart(2,'0') + ':' + String(brt.getSeconds()).padStart(2,'0');

    resultados.push({ numero, cor: getColor(numero), multiplicador: Math.max(...multiplicadores), todosMultiplicadores: multiplicadores, horario, timestamp });
  }

  return resultados;
}

function processarRodadas(rodadas) {
  const agora = Date.now();
  const umaHoraAtras = agora - 60 * 60 * 1000;

  return rodadas.map(r => {
    const [h, m, s] = r.horario.split(':').map(Number);
    const brtNow = new Date(agora - 3 * 3600000);
    const d = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate(), h+3, m, s));
    let ts = d.getTime();
    if (ts > agora + 60000) ts -= 24 * 3600000;
    return {
      numero: r.numero,
      cor: getColor(r.numero),
      multiplicador: r.multiplicador,
      todosMultiplicadores: r.multiplicadores,
      horario: r.horario,
      timestamp: ts,
    };
  }).filter(r => r.timestamp > umaHoraAtras)
    .sort((a, b) => b.timestamp - a.timestamp);
}

async function getData() {
  const agora = Date.now();
  if (cache.data.length > 0 && agora - cache.lastFetch < cache.ttl) {
    return { source: 'cache', data: cache.data, lastFetch: cache.lastFetch };
  }
  const data = await fetchComPuppeteer();
  cache.data = data;
  cache.lastFetch = agora;
  console.log(`[${new Date().toISOString()}] ${data.length} rodadas com multiplicador`);
  return { source: 'live', data, lastFetch: agora };
}

// ---- Servidor HTTP ----
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
      if (cache.data.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, source: 'cache-fallback', lastFetch: cache.lastFetch, total: cache.data.length, rodadas: cache.data }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
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

server.listen(PORT, async () => {
  console.log(`Rede Sinais Proxy v5 (Puppeteer) na porta ${PORT}`);
  await getBrowser().catch(console.error);
  getData().catch(console.error);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
