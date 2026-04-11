const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const app = express();
app.use(cors());
app.use(express.json());

let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
  }
  return browser;
}

app.post('/enrich', async (req, res) => {
  const { websiteUrl, name, city } = req.body;
  if (!websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });
  const result = {
    success: true, restaurantName: name || '', city: city || '',
    deliveryModel: 'unknown', deliveryFee: null, deliveryNote: '',
    restaurantType: '', instagramUrl: '', hasReservation: false,
    cashbackInfo: '', detectedPromos: [], errors: []
  };
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    // Step 1: Scrape main website
    console.log('[ENRICH] Step 1: ' + websiteUrl);
    try {
      await page.goto(websiteUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000));
      const wd = await page.evaluate(() => {
        const allLinks = [...document.querySelectorAll('a[href]')].map(a => a.href);
        const ig = allLinks.find(h => h.includes('instagram.com/') && !h.includes('/p/') && !h.includes('/explore'));
        const bt = document.body?.innerText?.toLowerCase() || '';
        const hasRes = bt.includes('reservier') || bt.includes('tisch buchen') || bt.includes('book a table')
          || allLinks.some(h => h.includes('opentable') || h.includes('quandoo') || h.includes('resmio'));
        let cuisine = '';
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try { const d = JSON.parse(s.textContent);
            if (d?.servesCuisine) cuisine = Array.isArray(d.servesCuisine) ? d.servesCuisine.join(', ') : d.servesCuisine;
          } catch(e) {}
        });
        return { instagram: ig || '', hasReservation: hasRes, cuisineType: cuisine, title: document.title };
      });
      result.instagramUrl = wd.instagram;
      result.hasReservation = wd.hasReservation;
      if (wd.cuisineType) result.restaurantType = wd.cuisineType;
      if (!result.restaurantType) {
        const combined = (wd.title + ' ' + (name || '')).toLowerCase();
        const cuisines = [
          { k: ['sushi','japanisch','japanese','ramen'], t: 'Japanese/Sushi' },
          { k: ['pizza','pizzeria','italiano','pasta'], t: 'Italian/Pizza' },
          { k: ['burger','burgers','smash'], t: 'Burger' },
          { k: ['vietnam','vietnamese','pho'], t: 'Vietnamese' },
          { k: ['indisch','indian','tandoori','curry'], t: 'Indian' },
          { k: ['türkisch','turkish','kebab','döner'], t: 'Turkish/Kebab' },
          { k: ['thai','pad thai'], t: 'Thai' },
          { k: ['chinesisch','chinese','asia','wok'], t: 'Asian' },
          { k: ['mexikanisch','mexican','taco','burrito'], t: 'Mexican' },
          { k: ['griechisch','greek','gyros'], t: 'Greek' },
          { k: ['bowl','bowls','poké','smoothie'], t: 'Bowl/Healthy' },
          { k: ['café','cafe','coffee','bakery'], t: 'Café/Bakery' },
        ];
        for (const c of cuisines) { if (c.k.some(k => combined.includes(k))) { result.restaurantType = c.t; break; } }
      }
    } catch(e) { result.errors.push('Website: ' + e.message); }

    // Step 2: Scrape Speisekarte/Shop page
    const shopUrl = websiteUrl.replace(/\/+$/, '') + '/Speisekarte';
    console.log('[ENRICH] Step 2: ' + shopUrl);
    try {
      await page.goto(shopUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 3000));
      const sd = await page.evaluate(() => {
        const bt = document.body?.innerText || '';
        const bl = bt.toLowerCase();
        const hasAbh = bl.includes('abholung') || bl.includes('pickup');
        const hasLief = bl.includes('lieferung') || bl.includes('delivery') || bl.includes('liefern');
        let fee = null;
        const patterns = [
          /liefergebühr[:\s]*(\d+[.,]\d{2})\s*€/i,
          /liefergebühr[:\s]*€?\s*(\d+[.,]\d{2})/i,
          /(\d+[.,]\d{2})\s*€?\s*liefergebühr/i,
          /lieferkosten[:\s]*(\d+[.,]\d{2})/i
        ];
        for (const p of patterns) {
          const m = bt.match(p);
          if (m) { fee = parseFloat(m[1].replace(',', '.')); break; }
        }
        const freeD = bl.includes('kostenlose lieferung') || bl.includes('gebührenfreie lieferung')
          || bl.includes('gratis lieferung') || bl.includes('free delivery');
        let cb = '';
        const cbM = bt.match(/erhalte?\s*(\d+[.,]\d{2})\s*€?\s*guthaben\s*für\s*jede\s*(\d+[.,]\d{2})\s*€/i);
        if (cbM) cb = cbM[0];
        return { hasAbholung: hasAbh, hasLieferung: hasLief, pickupOnly: hasAbh && !hasLief,
          deliveryFee: fee, freeDelivery: freeD, cashback: cb };
      });
      // Determine delivery model
      if (sd.pickupOnly) {
        result.deliveryModel = 'pickup';
        result.deliveryNote = 'Only Abholung — no delivery option';
      } else if (sd.hasLieferung) {
        if (sd.freeDelivery) {
          result.deliveryModel = 'own';
          result.deliveryFee = 0;
          result.deliveryNote = 'Free delivery — own drivers';
        } else if (sd.deliveryFee !== null) {
          result.deliveryFee = sd.deliveryFee;
          if (sd.deliveryFee <= 1.5) {
            result.deliveryModel = 'own';
            result.deliveryNote = 'Fee ' + sd.deliveryFee.toFixed(2) + ' EUR — own drivers (low fee)';
          } else {
            result.deliveryModel = 'net';
            result.deliveryNote = 'Fee ' + sd.deliveryFee.toFixed(2) + ' EUR — network (high fee)';
          }
        } else {
          result.deliveryModel = 'own';
          result.deliveryNote = 'Delivery available, fee not detected — assuming own drivers';
        }
      }
      if (sd.cashback) result.cashbackInfo = sd.cashback;
    } catch(e) { result.errors.push('Shop: ' + e.message); }
  } catch(e) {
    result.success = false;
    result.errors.push('Fatal: ' + e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log('[ENRICH] Done: ' + name + ' -> ' + result.deliveryModel);
  res.json(result);
});

// Bulk enrichment endpoint
app.post('/enrich-bulk', async (req, res) => {
  const { restaurants } = req.body;
  if (!restaurants?.length) return res.status(400).json({ error: 'restaurants array required' });
  const results = [];
  for (const r of restaurants) {
    console.log('[BULK] Processing: ' + (r.name || r.websiteUrl));
    try {
      const er = await fetch('http://localhost:3500/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r)
      });
      results.push(await er.json());
    } catch(e) {
      results.push({ success: false, originalName: r.name, error: e.message });
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  res.json({ total: restaurants.length, successful: results.filter(r => r.success).length, results });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Start server
const PORT = process.env.PORT || 3500;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Enrichment server running on port ' + PORT);
});

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
