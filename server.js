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
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--lang=de-DE'] });
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
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    // Capture browser console for debugging
    page.on('console', msg => console.log('[BROWSER]', msg.text()));
    console.log('[ENRICH] Step 1: Website ' + websiteUrl);
    try {
      await page.goto(websiteUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000));
      const wd = await page.evaluate(() => {
        const allLinks = [...document.querySelectorAll('a[href]')].map(a => a.href);
        const ig = allLinks.find(h => h.includes('instagram.com/') && !h.includes('/p/') && !h.includes('/explore') && !h.includes('/reel'));
        const bt = document.body.innerText.toLowerCase();
        const hasRes = bt.includes('reservier') || bt.includes('tisch buchen') || bt.includes('book a table')
          || allLinks.some(h => h.includes('opentable') || h.includes('quandoo') || h.includes('resmio'));
        let cuisine = '';
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try { const d = JSON.parse(s.textContent);
            if (d && d.servesCuisine) cuisine = Array.isArray(d.servesCuisine) ? d.servesCuisine.join(', ') : d.servesCuisine;
          } catch(e) {}
        });
        const colors = [];
        const skipBg = ['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','rgb(249, 250, 251)','rgb(0, 0, 0)','transparent'];
        document.querySelectorAll('div, header, nav').forEach(el => {
          const bg = getComputedStyle(el).backgroundColor;
          const rect = el.getBoundingClientRect();
          if (bg && !skipBg.includes(bg) && rect.width > 200 && rect.height > 10 && rect.height < 120) {
            if (!colors.some(c => c.hex === bg)) colors.push({ hex: bg, role: 'Brand' });
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
      if (wd.colors.length) result.brandColors = wd.colors;
      if (!result.restaurantType) {
        const combined = (wd.title + ' ' + (name || '')).toLowerCase();
        const ct = [['sushi','japanisch','ramen','Japanese/Sushi'],['pizza','pizzeria','italiano','pasta','Italian/Pizza'],
          ['burger','smash','Burger'],['vietnam','vietnamese','pho','Vietnamese'],['indisch','indian','tandoori','curry','Indian'],
          ['kebab','Turkish/Kebab'],['thai','Thai'],['chinese','asia','wok','Asian'],['mexican','taco','Mexican'],
          ['greek','gyros','Greek'],['bowl','smoothie','Bowl/Healthy'],['cafe','coffee','bakery','Bakery'],
          ['afghan','Afghan'],['arab','falafel','shawarma','Arabic']];
        for (const c of ct) { const t = c.pop(); if (c.some(k => combined.includes(k))) { result.restaurantType = t; break; } }
      }
    } catch(e) { result.errors.push('Website: ' + e.message); }

    // Step 2: Shop
    let menuUrl = shopUrl || '';
    if (menuUrl && menuUrl.includes('/Speisekarte')) menuUrl = menuUrl.replace('/Speisekarte', '/speisekarte');
    if (!menuUrl) menuUrl = websiteUrl.replace(/\/+$/, '') + '/speisekarte';
    console.log('[ENRICH] Step 2: Shop ' + menuUrl);
    try {
      await page.goto(menuUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 6000));
      const finalUrl = page.url();
      const redirectedHome = finalUrl.replace(/\/$/, '') === websiteUrl.replace(/\/$/, '');
      if (redirectedHome && !shopUrl) {
        console.log('[ENRICH] Trying /Speisekarte');
        await page.goto(websiteUrl.replace(/\/+$/, '') + '/Speisekarte', { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 5000));
      }
      const sd = await page.evaluate(() => {
        const rawText = document.body.innerText || '';
        // Normalize NBSP to space using charCode (ASCII-safe)
        const bt = rawText.split('').map(c => c.charCodeAt(0) === 160 ? ' ' : c).join('');
        const bl = bt.toLowerCase();
        const hasAbh = bl.includes('abholung') || bl.includes('pickup');
        const hasLief = bl.includes('lieferung') || bl.includes('delivery');
        let fee = null;
        const feeMatch = bt.match(/[Ll]iefergeb.hr.*?(\d+[.,]\d{2})/);
        if (feeMatch) fee = parseFloat(feeMatch[1].replace(',','.'));
        const freeD = bl.includes('kostenlose lieferung') || bl.includes('gratis lieferung') || bl.includes('free delivery');

        // CASHBACK: search in BOTH German and English
        let cb = '';
        const lines = bt.split('\n');
        for (const line of lines) {
          const ll = line.toLowerCase();
          // German: "Erhalte X € Guthaben für jede Y €"
          if (ll.includes('guthaben') && (ll.includes('jede') || ll.includes('every'))) { cb = line.trim(); break; }
          // English: "Earn X € credit for every Y €"
          if (ll.includes('credit') && (ll.includes('every') || ll.includes('jede'))) { cb = line.trim(); break; }
          // Generic: "rewards" + amount pattern
          if ((ll.includes('rewards') || ll.includes('belohnungen')) && /\d+[.,]\d{2}/.test(line)) { cb = line.trim(); break; }
        }
        console.log('[CB] guthaben:', bl.includes('guthaben'), 'credit:', bl.includes('credit'), 'rewards:', bl.includes('rewards'), 'Found:', cb ? 'YES' : 'NO');

        // PROMOS: German + English
        const promos = [];
        for (const line of lines) {
          const lt = line.trim();
          if (lt.length < 5 || lt.length > 150) continue;
          const ll = lt.toLowerCase();
          // German: rabatt, English: discount
          if (ll.includes('rabatt') || ll.includes('discount')) {
            if (!promos.includes(lt)) promos.push(lt);
          }
          // Promo codes
          else if (/code[:\s]+[A-Za-z0-9]{3,}/i.test(lt) && lt.length < 80) {
            if (!promos.includes(lt)) promos.push(lt);
          }
        }

        // MENU: h6 items (Foodamigos)
        const menu = [];
        const skipWords = ['abholung','lieferung','anmelden','registrieren','suche','home','pickup','delivery',
          'store','bewerte','adresse','impressum','datenschutz','cookie','sign','login',
          'warenkorb','gutscheine','belohnungen','coupons','beliebtesten','add','aktionsangebote',
          'erhalte','guthaben','rewards','hinzu','earn','credit','cart','popular'];
        document.querySelectorAll('h6').forEach(h6 => {
          const text = h6.textContent.trim();
          if (!text || text.length < 3 || text.length > 80) return;
          if (skipWords.some(s => text.toLowerCase().includes(s))) return;
          const parent = h6.closest('.snap-star') || h6.closest('[class*="cursor-pointer"]') || h6.parentElement.parentElement;
          if (!parent) return;
          const priceMatches = parent.textContent.match(/(\d+[.,]\d{2})/g);
          if (priceMatches && priceMatches.length > 0) {
            const price = priceMatches[priceMatches.length - 1];
            if (!menu.some(m => m.name === text)) menu.push({ name: text, price: price, category: '' });
          }
        });

        // CATEGORIES
        const categories = [];
        document.querySelectorAll('.react-horizontal-scrolling-menu--item p, .react-horizontal-scrolling-menu--item span').forEach(el => {
          const t = el.textContent.trim();
          if (t && t.length > 2 && t.length < 50) categories.push(t);
        });

        // JSON-LD fallback
        if (menu.length === 0) {
          document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
            try { const d = JSON.parse(s.textContent);
              const ex = (o) => { if (o && o.hasMenu && o.hasMenu.hasMenuSection) o.hasMenu.hasMenuSection.forEach(sec => {
                if (sec.name) categories.push(sec.name);
                (sec.hasMenuItem||[]).forEach(i => menu.push({ name: i.name, price: (i.offers && i.offers.price) || '', category: sec.name||'' }));
              }); };
              if (Array.isArray(d)) d.forEach(ex); else ex(d);
            } catch(e) {}
          });
        }

        // COLORS
        const colors = [];
        const skipBg = ['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','rgb(249, 250, 251)','rgb(0, 0, 0)','transparent'];
        document.querySelectorAll('div').forEach(el => {
          const bg = getComputedStyle(el).backgroundColor;
          const rect = el.getBoundingClientRect();
          if (bg && !skipBg.includes(bg) && rect.width > 300 && rect.height > 10 && rect.height < 80) {
            if (!colors.some(c => c.hex === bg)) colors.push({ hex: bg, role: 'Brand' });
          }
        });

        return { hasAbholung: hasAbh, hasLieferung: hasLief, pickupOnly: hasAbh && !hasLief,
          deliveryFee: fee, freeDelivery: freeD, cashback: cb,
          promos: promos.slice(0, 10), menu: menu.slice(0, 100), categories: [...new Set(categories)],
          shopColors: colors.slice(0, 3) };
      });
      if (sd.pickupOnly) { result.deliveryModel = 'pickup'; result.deliveryNote = 'Only Abholung'; }
      else if (sd.hasLieferung) {
        if (sd.freeDelivery) { result.deliveryModel = 'own'; result.deliveryFee = 0; result.deliveryNote = 'Free delivery'; }
        else if (sd.deliveryFee !== null) {
          result.deliveryFee = sd.deliveryFee;
          result.deliveryModel = sd.deliveryFee <= 1.5 ? 'own' : 'net';
          result.deliveryNote = 'Fee ' + sd.deliveryFee.toFixed(2) + ' EUR';
        } else { result.deliveryModel = 'unknown'; result.deliveryNote = 'Delivery available'; }
      }
      if (sd.cashback) result.cashbackInfo = sd.cashback;
      if (sd.promos.length) result.detectedPromos = sd.promos;
      if (sd.menu.length) result.menu = sd.menu;
      if (sd.categories.length) result.menuCategories = sd.categories;
      result.hasRealData = sd.menu.length > 0;
      if (sd.shopColors) sd.shopColors.forEach(c => { if (!result.brandColors.some(bc => bc.hex === c.hex)) result.brandColors.push(c); });
      console.log('[ENRICH] Step 2 done: menu=' + sd.menu.length + ' cb=' + (sd.cashback ? 'YES' : 'no') + ' promos=' + sd.promos.length);
    } catch(e) { result.errors.push('Shop: ' + e.message); }

    if (!result.instagramUrl && name) {
      console.log('[ENRICH] Step 3: DuckDuckGo IG');
      try {
        await page.goto('https://duckduckgo.com/?q=' + encodeURIComponent(name + ' ' + (city||'') + ' Instagram'), { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));
        const ig = await page.evaluate(() => {
          const a = [...document.querySelectorAll('a')].find(a => a.href && a.href.includes('instagram.com/') && !a.href.includes('/p/') && !a.href.includes('/explore'));
          return a ? (a.href.match(/(https:\/\/(?:www\.)?instagram\.com\/[\w._]+)/)||[])[1] || '' : '';
        });
        if (ig) result.instagramUrl = ig;
      } catch(e) { result.errors.push('IG: ' + e.message); }
    }
  } catch(e) { result.success = false; result.errors.push('Fatal: ' + e.message); }
  finally { if (page) await page.close().catch(() => {}); }
  console.log('[ENRICH] Done: ' + name + ' menu:' + result.menu.length + ' cb:' + (result.cashbackInfo ? 'YES' : 'no') + ' promos:' + result.detectedPromos.length + ' ig:' + (result.instagramUrl ? 'yes' : 'no'));
  res.json(result);
});
app.post('/enrich-bulk', async (req, res) => {
  const { restaurants } = req.body;
  if (!restaurants || !restaurants.length) return res.status(400).json({ error: 'restaurants array required' });
  const results = [];
  for (const r of restaurants) {
    try { const er = await fetch('http://localhost:3500/enrich', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(r) }); results.push(await er.json()); }
    catch(e) { results.push({ success:false, error:e.message }); }
    await new Promise(r => setTimeout(r, 3000));
  }
  res.json({ total:restaurants.length, successful:results.filter(r => r.success).length, results });
});
app.get('/health', (req, res) => res.json({ status:'ok', v: 9, time:new Date().toISOString() }));
const PORT = process.env.PORT || 3500;
app.listen(PORT, '0.0.0.0', () => console.log('Enrichment server v9 on port ' + PORT));
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
