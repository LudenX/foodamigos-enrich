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
  const { websiteUrl, shopUrl, name, city } = req.body;
  if (!websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });
  const result = {
    success: true, restaurantName: name || '', city: city || '',
    deliveryModel: 'unknown', deliveryFee: null, deliveryNote: '',
    restaurantType: '', instagramUrl: '', hasReservation: false,
    cashbackInfo: '', detectedPromos: [], errors: [],
    menu: [], menuCategories: [], brandColors: [],
    websiteTitle: '', websiteDescription: '', hasRealData: false, jsonLdFound: false
  };
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    // Step 1: Scrape main website
    console.log('[ENRICH] Step 1: Website ' + websiteUrl);
    try {
      await page.goto(websiteUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000));
      const wd = await page.evaluate(() => {
        const allLinks = [...document.querySelectorAll('a[href]')].map(a => a.href);
        const ig = allLinks.find(h => h.includes('instagram.com/') && !h.includes('/p/') && !h.includes('/explore') && !h.includes('/reel'));
        const bt = document.body?.innerText?.toLowerCase() || '';
        const hasRes = bt.includes('reservier') || bt.includes('tisch buchen') || bt.includes('book a table')
          || allLinks.some(h => h.includes('opentable') || h.includes('quandoo') || h.includes('resmio'));
        let cuisine = '';
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try { const d = JSON.parse(s.textContent);
            if (d?.servesCuisine) cuisine = Array.isArray(d.servesCuisine) ? d.servesCuisine.join(', ') : d.servesCuisine;
          } catch(e) {}
        });
        const colors = [];
        const btnEl = document.querySelector('button, .btn, [class*="button"], a[class*="order"], a[class*="bestell"]');
        if (btnEl) { const bg = getComputedStyle(btnEl).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)') colors.push({ hex: bg, role: 'Button' }); }
        const headerEl = document.querySelector('header, nav, .header, .navbar');
        if (headerEl) { const bg = getComputedStyle(headerEl).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)') colors.push({ hex: bg, role: 'Header' }); }
        return { instagram: ig || '', hasReservation: hasRes, cuisineType: cuisine,
          title: document.title, metaDesc: document.querySelector('meta[name="description"]')?.content || '', colors };
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
          { k: ['afghan','afghani','kabul','qabeli'], t: 'Afghan' },
          { k: ['arab','arabisch','falafel','shawarma','hummus'], t: 'Arabic/Middle Eastern' },
        ];
        for (const c of cuisines) { if (c.k.some(k => combined.includes(k))) { result.restaurantType = c.t; break; } }
      }
    } catch(e) { result.errors.push('Website: ' + e.message); }

    // Step 2: Scrape shop/menu page
    // Priority: shopUrl > /speisekarte (lowercase) > /Speisekarte (uppercase)
    let menuUrl = shopUrl || '';
    if (!menuUrl) {
      const base = websiteUrl.replace(/\/+$/, '');
      menuUrl = base + '/speisekarte';
    }
    console.log('[ENRICH] Step 2: Shop ' + menuUrl);
    try {
      await page.goto(menuUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 5000));

      // Check if redirected to homepage or 404
      const finalUrl = page.url();
      const pageTitle = await page.title();
      const is404 = pageTitle.toLowerCase().includes('404') || pageTitle.toLowerCase().includes('not found');
      const redirectedHome = !shopUrl && finalUrl === websiteUrl.replace(/\/+$/, '') + '/';

      // If lowercase failed, try uppercase
      if ((is404 || redirectedHome) && !shopUrl) {
        const base = websiteUrl.replace(/\/+$/, '');
        const altUrl = base + '/Speisekarte';
        console.log('[ENRICH] Trying uppercase: ' + altUrl);
        await page.goto(altUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 5000));
      }

      // Now extract data from the loaded page
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
          /zustellgebühr[:\s]*(\d+[.,]\d{2})/i
        ];
        for (const p of feePatterns) {
          const m = bt.match(p); if (m) { fee = parseFloat(m[1].replace(',', '.')); break; }
        }
        const freeD = bl.includes('kostenlose lieferung') || bl.includes('gebührenfreie lieferung')
          || bl.includes('gratis lieferung') || bl.includes('free delivery');

        // Cashback
        let cb = '';
        const cbM = bt.match(/erhalte?\s*(\d+[.,]\d{2})\s*€?\s*guthaben\s*für\s*jede\s*(\d+[.,]\d{2})\s*€/i);
        if (cbM) cb = cbM[0];

        // Promos
        const promos = [];
        const promoMatch = bt.match(/(\d+)\s*€\s*(rabatt|off|discount|gutschein)/gi);
        if (promoMatch) promoMatch.forEach(m => promos.push(m));
        const codeMatch = bt.match(/code[:\s]*["\'"]?(\w{3,15})["\'"]?/gi);
        if (codeMatch) codeMatch.forEach(m => promos.push(m));

        // ── FOODAMIGOS-SPECIFIC MENU EXTRACTION ──
        const menu = [];
        const categories = [];

        // Strategy 1: h6 elements with prices (Foodamigos pattern)
        document.querySelectorAll('h6').forEach(h6 => {
          const text = h6.textContent?.trim();
          if (!text || text.length < 2 || text.length > 80) return;
          // Skip navigation/UI elements
          const skip = ['abholung','lieferung','anmelden','registrieren','suche','home','menü',
            'store-details','bewerte','adresse','öffnungszeiten','impressum','datenschutz','cookie'];
          if (skip.some(s => text.toLowerCase().includes(s))) return;
          // Check if parent container has a price
          const parent = h6.closest('.snap-star') || h6.closest('[class*="cursor-pointer"]') || h6.parentElement?.parentElement;
          if (!parent) return;
          const parentText = parent.textContent || '';
          const prices = parentText.match(/(\d+[.,]\d{2})\s*€/g);
          if (prices && prices.length > 0) {
            const actualPrice = prices[prices.length - 1];
            const exists = menu.some(m => m.name === text);
            if (!exists) menu.push({ name: text, price: actualPrice, category: '', description: '' });
          }
        });

        // Strategy 2: Find category buttons in horizontal scroll
        document.querySelectorAll('[class*="horizontal-scroll"] button, [class*="scroll"] button, [class*="tab"] button').forEach(btn => {
          const t = btn.textContent?.trim();
          if (t && t.length > 1 && t.length < 40 && /[A-ZÄÖÜ]/.test(t)) {
            const skip = ['home','menü','store','anmelden','registrieren','suche'];
            if (!skip.some(s => t.toLowerCase().includes(s))) categories.push(t);
          }
        });

        // Strategy 3: If no h6 items found, try JSON-LD
        if (menu.length === 0) {
          document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
            try {
              const d = JSON.parse(s.textContent);
              const extract = (obj) => {
                if (obj?.hasMenu?.hasMenuSection) {
                  obj.hasMenu.hasMenuSection.forEach(sec => {
                    if (sec.name) categories.push(sec.name);
                    (sec.hasMenuItem || []).forEach(item => {
                      menu.push({ name: item.name, price: item.offers?.price ? item.offers.price + ' €' : '', category: sec.name || '', description: item.description || '' });
                    });
                  });
                }
              };
              if (Array.isArray(d)) d.forEach(extract); else extract(d);
            } catch(e) {}
          });
        }

        // Strategy 4: Text line scanning fallback
        if (menu.length === 0) {
          const lines = bt.split('\n').map(l => l.trim()).filter(l => l.length > 2);
          let currentCat = '';
          lines.forEach(line => {
            const pm = line.match(/(.*?)\s+(\d+[.,]\d{2})\s*€/);
            if (pm && pm[1].trim().length > 1 && pm[1].trim().length < 80) {
              menu.push({ name: pm[1].trim(), price: pm[2] + ' €', category: currentCat, description: '' });
            }
          });
        }

        return {
          hasAbholung: hasAbh, hasLieferung: hasLief, pickupOnly: hasAbh && !hasLief,
          deliveryFee: fee, freeDelivery: freeD, cashback: cb,
          promos: [...new Set(promos)].slice(0, 10),
          menu: menu.slice(0, 100), categories: [...new Set(categories)]
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
          // Try clicking "Lieferung" button to reveal delivery fee
          try {
            const liefBtn = await page.$$eval('h6, button, [role="button"], span', els =>
              els.filter(el => el.textContent?.trim() === 'Lieferung').map(el => {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width/2, y: r.y + r.height/2, visible: r.width > 0 };
              }).find(e => e.visible)
            );
            if (liefBtn) {
              await page.mouse.click(liefBtn.x, liefBtn.y);
              await new Promise(r => setTimeout(r, 2000));
              const feeAfterClick = await page.evaluate(() => {
                const bt = document.body?.innerText || '';
                const m = bt.match(/liefergebühr[:\s]*(\d+[.,]\d{2})\s*€/i) || bt.match(/(\d+[.,]\d{2})\s*€?\s*liefergebühr/i);
                return m ? parseFloat(m[1].replace(',', '.')) : null;
              });
              if (feeAfterClick !== null) {
                result.deliveryFee = feeAfterClick;
                if (feeAfterClick <= 1.5) {
                  result.deliveryModel = 'own';
                  result.deliveryNote = 'Fee ' + feeAfterClick.toFixed(2) + ' EUR — own drivers (after click)';
                } else {
                  result.deliveryModel = 'net';
                  result.deliveryNote = 'Fee ' + feeAfterClick.toFixed(2) + ' EUR — network (after click)';
                }
              } else {
                result.deliveryModel = 'own';
                result.deliveryNote = 'Delivery available, fee not detected after click';
              }
            }
          } catch(clickErr) {
            result.deliveryModel = 'unknown';
            result.deliveryNote = 'Delivery available, could not check fee';
          }
        }
      }
      if (sd.cashback) result.cashbackInfo = sd.cashback;
      if (sd.promos.length) result.detectedPromos = sd.promos;
      if (sd.menu.length) result.menu = sd.menu;
      if (sd.categories.length) result.menuCategories = sd.categories;
      result.hasRealData = sd.menu.length > 0;
      result.jsonLdFound = sd.menu.some(m => m.category);
    } catch(e) { result.errors.push('Shop: ' + e.message); }

    // Step 3: Google search for Instagram if not found
    if (!result.instagramUrl && name) {
      console.log('[ENRICH] Step 3: Google search for Instagram');
      try {
        const q = encodeURIComponent(name + ' ' + (city || '') + ' Instagram');
        await page.goto('https://www.google.com/search?q=' + q + '&hl=en', { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));

        // Handle Google consent page
        const hasConsent = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const acceptBtn = btns.find(b => b.textContent?.includes('Alle akzeptieren') || b.textContent?.includes('Accept all') || b.textContent?.includes('Ich stimme zu'));
          if (acceptBtn) { acceptBtn.click(); return true; }
          return false;
        });
        if (hasConsent) {
          await new Promise(r => setTimeout(r, 3000));
        }

        const igUrl = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a[href]')];
          const igLink = links.find(a => {
            const h = a.href;
            return h.includes('instagram.com/') && !h.includes('/p/') && !h.includes('/explore')
              && !h.includes('/reel') && !h.includes('instagram.com/accounts');
          });
          return igLink ? igLink.href : '';
        });
        if (igUrl) {
          const match = igUrl.match(/(https?:\/\/(?:www\.)?instagram\.com\/[\w._]+)/);
          if (match) result.instagramUrl = match[1];
        }
      } catch(e) { result.errors.push('Google IG: ' + e.message); }
    }

  } catch(e) {
    result.success = false;
    result.errors.push('Fatal: ' + e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log('[ENRICH] Done: ' + name + ' -> dm:' + result.deliveryModel + ' menu:' + result.menu.length + ' ig:' + (result.instagramUrl ? 'yes' : 'no'));
  res.json(result);
});

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
    await new Promise(r => setTimeout(r, 3000));
  }
  res.json({ total: restaurants.length, successful: results.filter(r => r.success).length, results });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
const PORT = process.env.PORT || 3500;
app.listen(PORT, '0.0.0.0', () => console.log('Enrichment server v3 on port ' + PORT));
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
