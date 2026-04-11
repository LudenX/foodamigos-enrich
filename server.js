const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const app = express();
app.use(cors());
app.use(express.json());
let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
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

    // Step 1: Main website
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
        // Brand colors: find colored elements (not transparent/white)
        const colors = [];
        const skipBg = ['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','rgb(249, 250, 251)','rgb(0, 0, 0)','transparent'];
        // Check colored divs (banners, headers)
        [...document.querySelectorAll('div, header, nav, a, button')].forEach(el => {
          const bg = getComputedStyle(el).backgroundColor;
          const rect = el.getBoundingClientRect();
          if (bg && !skipBg.includes(bg) && rect.width > 200 && rect.height > 10 && rect.height < 120) {
            if (!colors.some(c => c.hex === bg)) colors.push({ hex: bg, role: 'Brand element' });
          }
        });
        return { instagram: ig || '', hasReservation: hasRes, cuisineType: cuisine,
          title: document.title, metaDesc: document.querySelector('meta[name="description"]')?.content || '',
          colors: colors.slice(0, 5) };
      });
      result.instagramUrl = wd.instagram;
      result.hasReservation = wd.hasReservation;
      result.websiteTitle = wd.title; result.websiteDescription = wd.metaDesc;
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
          { k: ['café','cafe','coffee','bakery','bäckerei'], t: 'Café/Bakery' },
          { k: ['afghan','afghani','kabul','qabeli'], t: 'Afghan' },
          { k: ['arab','arabisch','falafel','shawarma'], t: 'Arabic/Middle Eastern' },
        ];
        for (const c of cuisines) { if (c.k.some(k => combined.includes(k))) { result.restaurantType = c.t; break; } }
      }
    } catch(e) { result.errors.push('Website: ' + e.message); }

    // Step 2: Shop/Speisekarte
    let menuUrl = shopUrl || '';
    if (menuUrl && menuUrl.endsWith('/Speisekarte')) menuUrl = menuUrl.slice(0,-12) + '/speisekarte';
    if (!menuUrl) menuUrl = websiteUrl.replace(/\/+$/, '') + '/speisekarte';
    console.log('[ENRICH] Step 2: Shop ' + menuUrl);
    try {
      await page.goto(menuUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 6000));
      const finalUrl = page.url();
      const redirectedHome = finalUrl.replace(/\/$/, '') === websiteUrl.replace(/\/$/, '');
      if (redirectedHome && !shopUrl) {
        const altUrl = websiteUrl.replace(/\/+$/, '') + '/Speisekarte';
        console.log('[ENRICH] Trying uppercase: ' + altUrl);
        await page.goto(altUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 5000));
      }

      const sd = await page.evaluate(() => {
        const bt = document.body?.innerText || '';
        const bl = bt.toLowerCase();
        const hasAbh = bl.includes('abholung'); const hasLief = bl.includes('lieferung');
        let fee = null;
        [/liefergebühr[:\s]*(\d+[.,]\d{2})\s*€/i, /(\d+[.,]\d{2})\s*€?\s*liefergebühr/i, /zustellgebühr[:\s]*(\d+[.,]\d{2})/i
        ].forEach(p => { if (!fee) { const m = bt.match(p); if (m) fee = parseFloat(m[1].replace(',','.')); }});
        const freeD = bl.includes('kostenlose lieferung') || bl.includes('gratis lieferung');

        // Cashback
        let cb = '';
        const cbM = bt.match(/erhalte?\s*(\d+[.,]\d{2})\s*€?\s*guthaben\s*für\s*jede\s*(\d+[.,]\d{2})\s*€/i);
        if (cbM) cb = cbM[0];

        // Promos
        const promos = [];
        const pm1 = bt.match(/(\d+)\s*€\s*(rabatt|off|discount|gutschein)/gi); if (pm1) pm1.forEach(m => promos.push(m));
        const pm2 = bt.match(/code[:\s]*["\'"]?(\w{3,15})["\'"]?/gi); if (pm2) pm2.forEach(m => promos.push(m));

        // ── FOODAMIGOS MENU: h6 + prices ──
        const menu = [];
        const skip = ['abholung','lieferung','anmelden','registrieren','suche','home','menü',
          'store-details','bewerte','adresse','öffnungszeiten','impressum','datenschutz','cookie',
          'warenkorb','gutscheine','belohnungen','coupons','am beliebtesten','add','aktionsangebote'];

        document.querySelectorAll('h6').forEach(h6 => {
          const text = h6.textContent?.trim();
          if (!text || text.length < 3 || text.length > 80) return;
          if (skip.some(s => text.toLowerCase().includes(s))) return;
          if (/^lieferung/i.test(text) || /registrieren/i.test(text)) return;
          const parent = h6.closest('.snap-star') || h6.closest('[class*="cursor-pointer"]') || h6.parentElement?.parentElement;
          if (!parent) return;
          const prices = parent.textContent?.match(/(\d+[.,]\d{2})\s*€/g);
          if (prices && prices.length > 0) {
            const actualPrice = prices[prices.length - 1];
            if (!menu.some(m => m.name === text)) menu.push({ name: text, price: actualPrice, category: '', description: '' });
          }
        });

        // ── CATEGORIES from react-horizontal-scrolling-menu ──
        const categories = [];
        document.querySelectorAll('.react-horizontal-scrolling-menu--item p, .react-horizontal-scrolling-menu--item span').forEach(el => {
          const t = el.textContent?.trim();
          if (t && t.length > 2 && t.length < 50 && !skip.some(s => t.toLowerCase() === s)) categories.push(t);
        });
        // Fallback: any uppercase text in scroll containers
        if (categories.length === 0) {
          document.querySelectorAll('[class*="scrollbar-hide"] button, [class*="scroll-smooth"] button').forEach(el => {
            const t = el.textContent?.trim();
            if (t && t.length > 2 && t.length < 40 && /^[A-ZÄÖÜ]/.test(t) && !skip.some(s => t.toLowerCase().includes(s))) categories.push(t);
          });
        }

        // JSON-LD fallback
        if (menu.length === 0) {
          document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
            try { const d = JSON.parse(s.textContent);
              const ex = (o) => { if (o?.hasMenu?.hasMenuSection) o.hasMenu.hasMenuSection.forEach(sec => {
                if (sec.name) categories.push(sec.name);
                (sec.hasMenuItem||[]).forEach(i => menu.push({ name: i.name, price: i.offers?.price?i.offers.price+' €':'', category: sec.name||'', description: i.description||'' }));
              }); };
              if (Array.isArray(d)) d.forEach(ex); else ex(d);
            } catch(e) {}
          });
        }

        // Brand colors from Speisekarte (colored divs/bars)
        const colors = [];
        const skipBg = ['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','rgb(249, 250, 251)','rgb(0, 0, 0)','transparent'];
        [...document.querySelectorAll('div')].forEach(el => {
          const bg = getComputedStyle(el).backgroundColor;
          const rect = el.getBoundingClientRect();
          if (bg && !skipBg.includes(bg) && rect.width > 300 && rect.height > 10 && rect.height < 80) {
            if (!colors.some(c => c.hex === bg)) colors.push({ hex: bg, role: 'Brand bar' });
          }
        });

        return { hasAbholung: hasAbh, hasLieferung: hasLief, pickupOnly: hasAbh && !hasLief,
          deliveryFee: fee, freeDelivery: freeD, cashback: cb,
          promos: [...new Set(promos)].slice(0, 10),
          menu: menu.slice(0, 100), categories: [...new Set(categories)],
          shopColors: colors.slice(0, 3) };
      });
      if (sd.pickupOnly) { result.deliveryModel = 'pickup'; result.deliveryNote = 'Only Abholung'; }
      else if (sd.hasLieferung) {
        if (sd.freeDelivery) { result.deliveryModel = 'own'; result.deliveryFee = 0; result.deliveryNote = 'Free delivery'; }
        else if (sd.deliveryFee !== null) {
          result.deliveryFee = sd.deliveryFee;
          result.deliveryModel = sd.deliveryFee <= 1.5 ? 'own' : 'net';
          result.deliveryNote = 'Fee ' + sd.deliveryFee.toFixed(2) + ' EUR — ' + (sd.deliveryFee <= 1.5 ? 'own drivers' : 'network');
        } else { result.deliveryModel = 'unknown'; result.deliveryNote = 'Delivery available, fee not detected'; }
      }
      if (sd.cashback) result.cashbackInfo = sd.cashback;
      if (sd.promos.length) result.detectedPromos = sd.promos;
      if (sd.menu.length) result.menu = sd.menu;
      if (sd.categories.length) result.menuCategories = sd.categories;
      result.hasRealData = sd.menu.length > 0;
      result.jsonLdFound = sd.menu.some(m => m.category);
      // Merge shop colors with website colors
      if (sd.shopColors?.length) {
        sd.shopColors.forEach(c => { if (!result.brandColors.some(bc => bc.hex === c.hex)) result.brandColors.push(c); });
      }
    } catch(e) { result.errors.push('Shop: ' + e.message); }

    // Step 3: DuckDuckGo search for Instagram (no consent issues)
    if (!result.instagramUrl && name) {
      console.log('[ENRICH] Step 3: DuckDuckGo for Instagram');
      try {
        const q = encodeURIComponent(name + ' ' + (city||'') + ' Instagram');
        await page.goto('https://duckduckgo.com/?q=' + q, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));
        const ig = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a[href]')];
          const igLink = links.find(a => {
            const h = a.href || '';
            return h.includes('instagram.com/') && !h.includes('/p/') && !h.includes('/explore')
              && !h.includes('/reel') && !h.includes('instagram.com/accounts') && !h.includes('instagram.com/about');
          });
          if (!igLink) return '';
          const m = igLink.href.match(/(https?:\/\/(?:www\.)?instagram\.com\/[\w._]+)/);
          return m ? m[1] : '';
        });
        if (ig) result.instagramUrl = ig;
        else {
          // Fallback: try Google with consent handling
          await page.goto('https://www.google.com/search?q=' + q + '&hl=de', { waitUntil: 'networkidle2', timeout: 12000 });
          await new Promise(r => setTimeout(r, 2000));
          await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const acc = btns.find(b => /alle akzeptieren|accept all|ich stimme zu|zustimmen/i.test(b.textContent));
            if (acc) acc.click();
          });
          await new Promise(r => setTimeout(r, 2000));
          const ig2 = await page.evaluate(() => {
            const a = [...document.querySelectorAll('a')].find(a => a.href?.includes('instagram.com/') && !a.href?.includes('/p/'));
            if (!a) return '';
            const m = a.href.match(/(https?:\/\/(?:www\.)?instagram\.com\/[\w._]+)/);
            return m ? m[1] : '';
          });
          if (ig2) result.instagramUrl = ig2;
        }
      } catch(e) { result.errors.push('IG search: ' + e.message); }
    }
  } catch(e) { result.success = false; result.errors.push('Fatal: ' + e.message); }
  finally { if (page) await page.close().catch(() => {}); }
  console.log('[ENRICH] Done: ' + name + ' dm:' + result.deliveryModel + ' menu:' + result.menu.length + ' cats:' + result.menuCategories.length + ' ig:' + (result.instagramUrl?'yes':'no') + ' cb:' + (result.cashbackInfo?'yes':'no'));
  res.json(result);
});
app.post('/enrich-bulk', async (req, res) => {
  const { restaurants } = req.body;
  if (!restaurants?.length) return res.status(400).json({ error: 'restaurants array required' });
  const results = [];
  for (const r of restaurants) {
    try { const er = await fetch('http://localhost:3500/enrich', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(r) }); results.push(await er.json()); }
    catch(e) { results.push({ success:false, error:e.message }); }
    await new Promise(r => setTimeout(r, 3000));
  }
  res.json({ total:restaurants.length, successful:results.filter(r=>r.success).length, results });
});
app.get('/health', (req, res) => res.json({ status:'ok', v: 5, time:new Date().toISOString() }));
const PORT = process.env.PORT || 3500;
app.listen(PORT, '0.0.0.0', () => console.log('Enrichment server v5 on port ' + PORT));
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
