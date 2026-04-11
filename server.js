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
    cashbackInfo: '', detectedPromos: [], errors: [],
    menu: [], menuCategories: [], brandColors: [],
    websiteTitle: '', websiteDescription: ''
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
        // Extract CSS brand colors
        const colors = [];
        const cs = getComputedStyle(document.documentElement);
        const props = ['--primary-color','--brand-color','--accent-color','--main-color','--theme-color'];
        props.forEach(p => { const v = cs.getPropertyValue(p).trim(); if (v) colors.push({ hex: v, role: p }); });
        // Get colors from key elements
        const btnEl = document.querySelector('button, .btn, [class*="button"], a[class*="order"]');
        if (btnEl) { const bg = getComputedStyle(btnEl).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)') colors.push({ hex: bg, role: 'Button' }); }
        const headerEl = document.querySelector('header, nav, .header, .navbar');
        if (headerEl) { const bg = getComputedStyle(headerEl).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)') colors.push({ hex: bg, role: 'Header' }); }
        const linkEl = document.querySelector('a');
        if (linkEl) { const c = getComputedStyle(linkEl).color; if (c) colors.push({ hex: c, role: 'Link' }); }
        return { instagram: ig || '', hasReservation: hasRes, cuisineType: cuisine,
          title: document.title, metaDesc: document.querySelector('meta[name="description"]')?.content || '',
          colors };
      });
      result.instagramUrl = wd.instagram;
      result.hasReservation = wd.hasReservation;
      result.websiteTitle = wd.title;
      result.websiteDescription = wd.metaDesc;
      if (wd.cuisineType) result.restaurantType = wd.cuisineType;
      if (wd.colors?.length) result.brandColors = wd.colors;
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

    // Step 2: Scrape Speisekarte — full menu + delivery + promos
    const shopUrl = websiteUrl.replace(/\/+$/, '') + '/Speisekarte';
    console.log('[ENRICH] Step 2: ' + shopUrl);
    try {
      await page.goto(shopUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 4000));
      const sd = await page.evaluate(() => {
        const bt = document.body?.innerText || '';
        const bl = bt.toLowerCase();

        // Delivery detection
        const hasAbh = bl.includes('abholung') || bl.includes('pickup');
        const hasLief = bl.includes('lieferung') || bl.includes('delivery') || bl.includes('liefern');
        let fee = null;
        const feePatterns = [
          /liefergebühr[:\s]*(\d+[.,]\d{2})\s*€/i,
          /liefergebühr[:\s]*€?\s*(\d+[.,]\d{2})/i,
          /(\d+[.,]\d{2})\s*€?\s*liefergebühr/i,
          /lieferkosten[:\s]*(\d+[.,]\d{2})/i
        ];
        for (const p of feePatterns) {
          const m = bt.match(p);
          if (m) { fee = parseFloat(m[1].replace(',', '.')); break; }
        }
        const freeD = bl.includes('kostenlose lieferung') || bl.includes('gebührenfreie lieferung')
          || bl.includes('gratis lieferung') || bl.includes('free delivery');

        // Cashback
        let cb = '';
        const cbM = bt.match(/erhalte?\s*(\d+[.,]\d{2})\s*€?\s*guthaben\s*für\s*jede\s*(\d+[.,]\d{2})\s*€/i);
        if (cbM) cb = cbM[0];

        // Promo detection
        const promos = [];
        const promoBanners = document.querySelectorAll('[class*="banner"], [class*="promo"], [class*="discount"], [class*="rabatt"], [class*="aktion"]');
        promoBanners.forEach(el => {
          const txt = el.textContent?.trim();
          if (txt && txt.length < 200) promos.push(txt);
        });
        const promoMatch = bt.match(/(\d+)\s*€\s*(rabatt|off|discount|gutschein)/gi);
        if (promoMatch) promoMatch.forEach(m => promos.push(m));
        const codeMatch = bt.match(/code[:\s]*["\'"]?(\w{3,15})["\'"]?/gi);
        if (codeMatch) codeMatch.forEach(m => promos.push(m));

        // Menu extraction — find all items with prices
        const menu = [];
        const categories = [];
        const priceRegex = /(\d+[.,]\d{2})\s*€/;

        // Method 1: JSON-LD menu
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try {
            const d = JSON.parse(s.textContent);
            const checkMenu = (obj) => {
              if (obj?.hasMenu?.hasMenuSection) {
                obj.hasMenu.hasMenuSection.forEach(sec => {
                  const cat = sec.name || '';
                  if (cat && !categories.includes(cat)) categories.push(cat);
                  (sec.hasMenuItem || []).forEach(item => {
                    menu.push({ name: item.name, price: item.offers?.price ? item.offers.price + ' €' : '', category: cat, description: item.description || '' });
                  });
                });
              }
              if (obj?.hasMenuItem) {
                obj.hasMenuItem.forEach(item => {
                  menu.push({ name: item.name, price: item.offers?.price ? item.offers.price + ' €' : '', category: '', description: item.description || '' });
                });
              }
            };
            if (Array.isArray(d)) d.forEach(checkMenu); else checkMenu(d);
          } catch(e) {}
        });

        // Method 2: DOM-based extraction if JSON-LD didn't work
        if (menu.length === 0) {
          // Look for heading + price patterns in the rendered page
          const allEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="category"],[class*="gruppe"]');
          allEls.forEach(el => {
            const t = el.textContent?.trim();
            if (t && t.length > 1 && t.length < 60 && !priceRegex.test(t)) {
              if (!categories.includes(t)) categories.push(t);
            }
          });

          // Find item containers with name + price
          const itemEls = document.querySelectorAll('[class*="item"], [class*="product"], [class*="dish"], [class*="artikel"], [class*="gericht"]');
          itemEls.forEach(el => {
            const txt = el.textContent?.trim() || '';
            const pm = txt.match(priceRegex);
            if (pm) {
              const price = pm[0];
              const nameText = txt.split(pm[0])[0].trim().split('\n')[0].trim();
              if (nameText.length > 1 && nameText.length < 80) {
                menu.push({ name: nameText, price, category: '', description: '' });
              }
            }
          });

          // Fallback: scan all text for "Name ... Price" patterns
          if (menu.length === 0) {
            const lines = bt.split('\n').map(l => l.trim()).filter(l => l);
            let currentCat = '';
            lines.forEach(line => {
              const pm = line.match(/(.*?)\s+(\d+[.,]\d{2})\s*€/);
              if (pm && pm[1].trim().length > 1 && pm[1].trim().length < 80) {
                menu.push({ name: pm[1].trim(), price: pm[2] + ' €', category: currentCat, description: '' });
              } else if (line.length > 2 && line.length < 40 && !priceRegex.test(line) && /^[A-ZÄÖÜ]/.test(line)) {
                currentCat = line;
                if (!categories.includes(line)) categories.push(line);
              }
            });
          }
        }

        return {
          hasAbholung: hasAbh, hasLieferung: hasLief, pickupOnly: hasAbh && !hasLief,
          deliveryFee: fee, freeDelivery: freeD, cashback: cb,
          promos: [...new Set(promos)].slice(0, 10),
          menu: menu.slice(0, 100), categories
        };
      });
      // Delivery model
      if (sd.pickupOnly) {
        result.deliveryModel = 'pickup';
        result.deliveryNote = 'Only Abholung — no delivery option';
      } else if (sd.hasLieferung) {
        if (sd.freeDelivery) {
          result.deliveryModel = 'own'; result.deliveryFee = 0;
          result.deliveryNote = 'Free delivery — own drivers';
        } else if (sd.deliveryFee !== null) {
          result.deliveryFee = sd.deliveryFee;
          if (sd.deliveryFee <= 1.5) {
            result.deliveryModel = 'own';
            result.deliveryNote = 'Fee ' + sd.deliveryFee.toFixed(2) + ' EUR — own drivers';
          } else {
            result.deliveryModel = 'net';
            result.deliveryNote = 'Fee ' + sd.deliveryFee.toFixed(2) + ' EUR — network';
          }
        } else {
          result.deliveryModel = 'own';
          result.deliveryNote = 'Delivery available, fee not detected';
        }
      }
      if (sd.cashback) result.cashbackInfo = sd.cashback;
      if (sd.promos.length) result.detectedPromos = sd.promos;
      if (sd.menu.length) result.menu = sd.menu;
      if (sd.categories.length) result.menuCategories = sd.categories;
      result.hasRealData = sd.menu.length > 0;
      result.jsonLdFound = sd.menu.length > 0;
    } catch(e) { result.errors.push('Shop: ' + e.message); }
  } catch(e) {
    result.success = false;
    result.errors.push('Fatal: ' + e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log('[ENRICH] Done: ' + name + ' -> ' + result.deliveryModel + ', menu: ' + result.menu.length + ' items');
  res.json(result);
});

// Bulk enrichment
app.post('/enrich-bulk', async (req, res) => {
  const { restaurants } = req.body;
  if (!restaurants?.length) return res.status(400).json({ error: 'restaurants array required' });
  const results = [];
  for (const r of restaurants) {
    console.log('[BULK] ' + (r.name || r.websiteUrl));
    try {
      const er = await fetch('http://localhost:3500/enrich', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r)
      });
      results.push(await er.json());
    } catch(e) { results.push({ success: false, originalName: r.name, error: e.message }); }
    await new Promise(r => setTimeout(r, 2000));
  }
  res.json({ total: restaurants.length, successful: results.filter(r => r.success).length, results });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3500;
app.listen(PORT, '0.0.0.0', () => console.log('Enrichment server on port ' + PORT));
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
