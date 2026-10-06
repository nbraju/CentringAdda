/*************************************************************************
 * MESTRICENTRING — Google Sheets backend v2  (Code.gs)
 * SETUP (once):
 *  1. Create a Google Sheet, copy its ID into SHEET_ID below.
 *     The ID is the long string between /d/ and /edit in the sheet URL —
 *     NOT the /exec web-app URL.
 *  2. Extensions > Apps Script > paste this file > run setupTabs() once
 *     (creates every tab with headers + starter rates/zones/steel/demand).
 *  3. Deploy > New deployment > Web app > Execute as: Me > Access: Anyone.
 *  4. Paste the /exec URL and the same API_TOKEN into index.html (API, TOKEN).
 * DATABASES (one tab per user type):
 *  Mestris -> MESTRIS | Suppliers -> SUPPLIERS + SUPPLIER_INVENTORY
 *  Builders -> BUILDERS + PROJECTS | Quotes -> QUOTES
 * ADMIN: new mestris/suppliers arrive with status PENDING. Set status=ACTIVE
 *  (and verified=TRUE for the badge) to list them. You get an email for each.
 *************************************************************************/

/* ⬇️ FIX #1: this must be the SPREADSHEET ID (from the sheet URL), not the /exec URL. */
const SHEET_ID    = '1ebErQu0q6PgSCAHWQ9LymkQ01A2CLLsBcJ-3aIAwzo8';   // e.g. 1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789
const API_TOKEN   = '7U4ANqbVpvryAWsm';           // must equal TOKEN in index.html (not a real secret)
const ADMIN_EMAIL = 'nbraju@hotmail.com';

const T = {
  CONFIG:'CONFIG', ZONES:'ZONE_MASTER', PTYPES:'PROJECT_TYPES', RATES:'RATE_MASTER',
  STEEL:'STEEL_DEFAULTS', MESTRIS:'MESTRIS', SUPPLIERS:'SUPPLIERS', INV:'SUPPLIER_INVENTORY',
  BUILDERS:'BUILDERS', PROJECTS:'PROJECTS', QUOTES:'QUOTES', LOG:'ESTIMATE_LOG',
  MSG:'CONTACT_MESSAGES', DEMAND:'HIRE_DEMAND'
};

// Only these columns ever leave the sheet publicly.
const PUB = {
  MESTRIS:  ['mestri_id','name','phone','whatsapp','experience_years','zones','specializations','gang_size','rating','verified'],
  SUPPLIERS:['supplier_id','company_name','contact_person','phone','zones_served','verified'],
  INV:      ['item_id','supplier_id','item_name','category','unit','daily_rent','min_qty','available_qty'],
  PROJECTS: ['project_id','posted_at','title','location_zone','slab_sqft','beam_rft','columns','hire_days']
};

/* ============================ READ PATH (JSONP) ============================ */
function doGet(e) {
  const p = e.parameter || {};
  const cb = /^[\w.$]+$/.test(p.callback || '') ? p.callback : null;
  let out;
  try { out = { ok: true, data: route_(p) }; }
  catch (err) { out = { ok: false, error: String(err.message || err) }; }
  const s = JSON.stringify(out);
  return cb
    ? ContentService.createTextOutput(cb + '(' + s + ')').setMimeType(ContentService.MimeType.JAVASCRIPT)
    : json_(out);
}

function route_(p) {
  switch (p.action) {
    case 'getBootstrap':
      return cached_('getBootstrap', () => ({
        rates: table_(T.RATES, r => isTrue_(r.active)), zones: table_(T.ZONES, r => isTrue_(r.active)),
        projects: table_(T.PTYPES, r => isTrue_(r.active)), steel: table_(T.STEEL), config: config_()
      }));
    case 'getMestris':
      return cached_('getMestris', () => pick_(table_(T.MESTRIS, r => up_(r.status) === 'ACTIVE'), PUB.MESTRIS));
    case 'getSuppliers':
      return cached_('getSuppliers', () => pick_(table_(T.SUPPLIERS, r => up_(r.status) === 'ACTIVE'), PUB.SUPPLIERS));
    case 'getInventory':
      return pick_(table_(T.INV, r => r.supplier_id === p.supplier_id && Number(r.available_qty) > 0), PUB.INV);
    case 'getDemand':
      return table_(T.DEMAND);
    case 'getProjects': {            // builder contact is shown only to a listed mestri
      const unlocked = !!findMestri_(p.phone);
      const cols = PUB.PROJECTS.concat(unlocked ? ['builder_contact'] : []);
      return { unlocked, projects: pick_(table_(T.PROJECTS, r => up_(r.status) === 'OPEN').reverse(), cols) };
    }
    case 'getMyProjects': {          // a builder sees own projects + incoming quotes
      const ph = d10_(p.phone); if (ph.length !== 10) throw new Error('Enter a valid phone');
      const mestris = table_(T.MESTRIS), quotes = table_(T.QUOTES);
      return table_(T.PROJECTS, r => r.project_id && d10_(r.builder_contact) === ph).reverse().map(pr => {
        const o = pick1_(pr, PUB.PROJECTS.concat(['status']));
        o.quotes = quotes.filter(q => q.project_id === pr.project_id).map(q => {
          const m = mestris.find(x => x.mestri_id === q.mestri_id) || {};
          return { amount: q.amount, message: q.message, created_at: q.created_at, mestri_name: m.name || '', mestri_phone: m.phone || '' };
        });
        return o;
      });
    }
    default: return { service: 'mestricentring-api', version: '2.0', time: now_() };
  }
}

/* ============================ WRITE PATH ============================ */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const b = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (b.token !== API_TOKEN) return json_({ ok: false, error: 'unauthorized' });
    if (b.hp) return json_({ ok: true });                 // honeypot: bots fill hidden field
    throttle_();
    const fn = ACTIONS[b.action];
    if (!fn) return json_({ ok: false, error: 'unknown action' });
    const res = fn(b);
    CacheService.getScriptCache().removeAll(['getBootstrap', 'getMestris', 'getSuppliers']);
    return json_(Object.assign({ ok: true }, res));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally { lock.releaseLock(); }
}

const ACTIONS = {
  logEstimate: b => ({ id: add_(T.LOG, {
    log_id: uid_('EST'), timestamp: now_(), slab_sqft: num_(b.slab), beam_rft: num_(b.beam), columns: num_(b.cols),
    hire_days: num_(b.days), zone_mult: num_(b.zoneMult), project_mult: num_(b.projMult), grand_total: num_(b.grandTotal),
    per_sqft: num_(b.perSqft), steel_kg: num_(b.steelKg), inputs_json: c_(JSON.stringify(b.inputs || {}), 1000) }) }),

  contactMessage: b => {
    need_(b, ['name', 'contact', 'message']);
    const id = add_(T.MSG, { msg_id: uid_('MSG'), timestamp: now_(), name: c_(b.name, 80), contact: c_(b.contact, 80),
      message: c_(b.message, 1000), source_page: c_(b.page || 'contact', 30), status: 'NEW' });
    notify_('New message from ' + b.name, b.contact + '\n\n' + b.message);
    return { id };
  },

  registerMestri: b => {
    need_(b, ['name']); const ph = ph_(b.phone);
    if (table_(T.MESTRIS, r => d10_(r.phone) === ph).length) throw new Error('This mobile number is already registered');
    const id = add_(T.MESTRIS, { mestri_id: uid_('MST'), joined_at: now_(), name: c_(b.name, 80), phone: ph,
      whatsapp: b.whatsapp ? ph_(b.whatsapp) : ph, experience_years: num_(b.experience), zones: c_(b.zones, 80),
      specializations: c_(b.specializations, 120), gang_size: num_(b.gangSize), rating: 0, verified: 'FALSE', status: 'PENDING' });
    notify_('New MESTRI to verify: ' + b.name, 'ID ' + id + ' | ' + ph);
    return { id };
  },

  registerSupplier: b => {
    need_(b, ['company', 'contactPerson']); const ph = ph_(b.phone);
    if (table_(T.SUPPLIERS, r => d10_(r.phone) === ph).length) throw new Error('This mobile number is already registered');
    const id = add_(T.SUPPLIERS, { supplier_id: uid_('SUP'), company_name: c_(b.company, 100), contact_person: c_(b.contactPerson, 80),
      phone: ph, email: c_(b.email, 80), zones_served: c_(b.zones, 80), gst_no: c_(b.gst, 20), verified: 'FALSE', status: 'PENDING' });
    notify_('New SUPPLIER to verify: ' + b.company, 'ID ' + id + ' | ' + ph);
    return { id };
  },

  addInventory: b => {            // add a new item, or update one when itemId is given
    const ph = ph_(b.phone);
    const s = table_(T.SUPPLIERS, r => r.supplier_id === c_(b.supplierId, 20) && d10_(r.phone) === ph && up_(r.status) === 'ACTIVE')[0];
    if (!s) throw new Error('Supplier ID and mobile do not match an active supplier');
    if (b.itemId) {
      const ok = update_(T.INV, r => r.item_id === c_(b.itemId, 20) && r.supplier_id === s.supplier_id,
        { daily_rent: num_(b.dailyRent), available_qty: num_(b.availableQty), updated_at: now_() });
      if (!ok) throw new Error('Item ID not found for your account');
      return { id: b.itemId };
    }
    need_(b, ['itemName']);
    return { id: add_(T.INV, { item_id: uid_('ITM'), supplier_id: s.supplier_id, item_name: c_(b.itemName, 80), category: c_(b.category, 40),
      unit: c_(b.unit || 'pc', 15), daily_rent: num_(b.dailyRent), min_qty: num_(b.minQty), available_qty: num_(b.availableQty), updated_at: now_() }) };
  },

  postProject: b => {
    need_(b, ['name']); const ph = ph_(b.phone);
    if (!(Number(b.slab) > 0)) throw new Error('Enter slab area');
    const bid = upsertBuilder_(c_(b.name, 80), ph);
    const id = add_(T.PROJECTS, { project_id: uid_('PRJ'), posted_at: now_(), builder_id: bid, builder_contact: c_(b.name, 80) + ' | ' + ph,
      title: c_(b.title || 'Centring project', 100), location_zone: c_(b.zone, 20), slab_sqft: num_(b.slab), beam_rft: num_(b.beam),
      columns: num_(b.cols), hire_days: num_(b.days) || 21, status: 'OPEN' });
    notify_('New project: ' + b.title, id + ' | ' + b.name + ' ' + ph);
    return { id };
  },

  closeProject: b => {
    const ph = ph_(b.phone);
    if (!update_(T.PROJECTS, r => r.project_id === c_(b.projectId, 20) && d10_(r.builder_contact) === ph, { status: 'CLOSED' }))
      throw new Error('Project not found for this mobile');
    return {};
  },

  submitQuote: b => {
    const m = findMestri_(b.mestriPhone);
    if (!m) throw new Error('Only listed mestris can quote. Register first, or wait for verification.');
    const pid = c_(b.projectId, 20);
    if (!table_(T.PROJECTS, r => r.project_id === pid && up_(r.status) === 'OPEN').length) throw new Error('Project is closed');
    if (!(Number(b.amount) > 0)) throw new Error('Enter your quote amount');
    if (table_(T.QUOTES, q => q.project_id === pid && q.mestri_id === m.mestri_id).length) throw new Error('You already quoted this project');
    return { id: add_(T.QUOTES, { quote_id: uid_('QT'), created_at: now_(), project_id: pid, mestri_id: m.mestri_id,
      amount: num_(b.amount), message: c_(b.message, 300), status: 'PENDING' }) };
  }
};

function upsertBuilder_(name, ph) {
  const ex = table_(T.BUILDERS, r => d10_(r.phone) === ph)[0];
  if (ex) return ex.builder_id;
  return add_(T.BUILDERS, { builder_id: uid_('BLD'), company: name, contact_person: name, phone: ph, email: '', tier: 'FREE', joined_at: now_() });
}
function findMestri_(phone) {
  const ph = d10_(phone);
  return ph.length === 10 ? table_(T.MESTRIS, r => up_(r.status) === 'ACTIVE' && d10_(r.phone) === ph)[0] : null;
}

/* Clears the cached lists whenever you edit the sheet by hand (approve a mestri, change status...). */
function onEdit(e) { CacheService.getScriptCache().removeAll(['getBootstrap', 'getMestris', 'getSuppliers']); }

/* ============================ helpers ============================ */
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function uid_(p) { return p + '-' + Utilities.getUuid().slice(0, 8).toUpperCase(); }
function now_() { return new Date().toISOString(); }
function d10_(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(-10); }
function ph_(v) { const p = d10_(v); if (p.length !== 10) throw new Error('Enter a valid 10-digit mobile number'); return p; }
function num_(v) { const n = Number(v); return isFinite(n) && n >= 0 ? n : 0; }
function c_(v, max) {            // trim, cap length, neutralise spreadsheet formulas
  const s = String(v == null ? '' : v).trim().slice(0, max || 200);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function need_(b, keys) { keys.forEach(k => { if (!String(b[k] == null ? '' : b[k]).trim()) throw new Error('Missing: ' + k); }); }
function up_(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
function isTrue_(v) { return up_(v) === 'TRUE'; }
function notify_(subject, body) { try { MailApp.sendEmail(ADMIN_EMAIL, '[MestriCentring] ' + subject, body); } catch (e) {} }
function throttle_() {           // global cap: 60 writes / minute
  const c = CacheService.getScriptCache(), k = 'rl' + Math.floor(Date.now() / 60000);
  const n = Number(c.get(k) || 0) + 1; c.put(k, String(n), 90);
  if (n > 60) throw new Error('Server busy, try again in a minute');
}
function cached_(key, fn) {
  const c = CacheService.getScriptCache(), hit = c.get(key);
  if (hit) return JSON.parse(hit);
  const v = fn(); try { c.put(key, JSON.stringify(v), 300); } catch (e) {}
  return v;
}
function pick1_(r, cols) { const o = {}; cols.forEach(k => o[k] = r[k]); return o; }
function pick_(rows, cols) { return rows.map(r => pick1_(r, cols)); }
function sheet_(name) {
  const s = SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
  if (!s) throw new Error('Missing tab: ' + name + ' (run setupTabs)');
  return s;
}
function hdr_(v) { return v[0].map(h => String(h).trim().toLowerCase()); }
function obj_(h, row) { const o = {}; h.forEach((k, i) => o[k] = row[i]); return o; }
function table_(name, filter) {
  const v = sheet_(name).getDataRange().getValues();
  if (v.length < 2) return [];
  const h = hdr_(v);
  const rows = v.slice(1).map(r => obj_(h, r)).filter(r => r[h[0]] !== '' && r[h[0]] != null);
  return filter ? rows.filter(filter) : rows;
}
function config_() {
  const o = {}; sheet_(T.CONFIG).getDataRange().getValues().slice(1).forEach(r => { if (r[0]) o[r[0]] = r[1]; }); return o;
}
function add_(name, o) {
  const s = sheet_(name), h = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(x => String(x).trim().toLowerCase());
  s.appendRow(h.map(k => o[k] !== undefined ? o[k] : ''));
  return o[h[0]];
}
function update_(name, pred, patch) {
  const s = sheet_(name), v = s.getDataRange().getValues(), h = hdr_(v);
  for (let i = 1; i < v.length; i++) {
    if (!pred(obj_(h, v[i]))) continue;
    Object.keys(patch).forEach(k => { const c = h.indexOf(k); if (c >= 0) s.getRange(i + 1, c + 1).setValue(patch[k]); });
    return true;
  }
  return false;
}

/* ============================ one-time setup ============================ */
function setupTabs() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const S = {
    CONFIG: [['key','value','updated_at'], [['phone','+91 6304877983',''], ['email', ADMIN_EMAIL, '']]],
    ZONE_MASTER: [['zone_code','zone_name','multiplier','active'],
      [['ZONE1','ZONE1',1,'TRUE'],['ZONE2','ZONE2',1.08,'TRUE'],['ZONE3','ZONE3',1.15,'TRUE'],['ZONE4','ZONE4',0.9,'TRUE']]],
    PROJECT_TYPES: [['type_code','type_name','multiplier','active'],
      [['T1','Individual house',1,'TRUE'],['T2','Apartment G+2 to G+4',0.95,'TRUE'],['T3','Commercial complex',1.12,'TRUE']]],
    RATE_MASTER: [['item_code','item_name','category','unit','base_rate','active','updated_at'], [
      ['L-F01','Slab shuttering — fixing','labour_fix','sqft',12],['L-F02','Beam shuttering — fixing','labour_fix','RFT',30],
      ['L-F03','Column shuttering — fixing','labour_fix','sqft',50],['L-D01','Slab dismantling + cleaning','labour_dis','sqft',6],
      ['L-D02','Beam dismantling','labour_dis','RFT',15],['L-D03','Column dismantling','labour_dis','sqft',25],
      ['L-D04','Plate cleaning + stacking','labour_dis','sqft',2.5],['M-H01','MS shuttering plate hire','hire','sqft×day',3],
      ['M-H02','MS adjustable prop hire','hire','prop×day',12],['M-H03','Top jack (U-head) hire','hire','pc×day',10],
      ['M-H04','Bottom base plate hire','hire','pc×day',8],['M-H05','Wooden runner hire','hire','RFT×day',1],
      ['C-01','Mould release oil','consumable','litre',45],['C-02','Binding wire (annealed)','consumable','kg',65],
      ['C-03','Nails, assorted','consumable','kg',90]].map(r => r.concat(['TRUE', '']))],
    STEEL_DEFAULTS: [['key','value'], [['steelRate',72],['slabSteelKg',5.2],['beamSteelKg',9.5],['colSteelKg',58]]],
    MESTRIS: [['mestri_id','joined_at','name','phone','whatsapp','experience_years','zones','specializations','gang_size','rating','verified','status']],
    SUPPLIERS: [['supplier_id','company_name','contact_person','phone','email','zones_served','gst_no','verified','status']],
    SUPPLIER_INVENTORY: [['item_id','supplier_id','item_name','category','unit','daily_rent','min_qty','available_qty','updated_at']],
    BUILDERS: [['builder_id','company','contact_person','phone','email','tier','joined_at']],
    PROJECTS: [['project_id','posted_at','builder_id','builder_contact','title','location_zone','slab_sqft','beam_rft','columns','hire_days','status']],
    QUOTES: [['quote_id','created_at','project_id','mestri_id','amount','message','status']],
    ESTIMATE_LOG: [['log_id','timestamp','slab_sqft','beam_rft','columns','hire_days','zone_mult','project_mult','grand_total','per_sqft','steel_kg','inputs_json']],
    CONTACT_MESSAGES: [['msg_id','timestamp','name','contact','message','source_page','status']],
    HIRE_DEMAND: [['item','unit','rent_low','rent_high','demand_zone'],
      [['MS shuttering plate','sqft/day',2.8,3.2,'High'],['Adjustable prop','pc/day',11,14,'Very high'],
       ['Top jack (U-head)','pc/day',9,11,'High'],['Wooden runner','RFT/day',0.9,1.2,'Medium']]]
  };
  Object.keys(S).forEach(tab => {
    let s = ss.getSheetByName(tab) || ss.insertSheet(tab);
    if (s.getLastRow() === 0) {
      s.appendRow(S[tab][0]); s.setFrozenRows(1);
      (S[tab][1] || []).forEach(r => s.appendRow(r));
    }
  });
}