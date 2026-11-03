// Run: node --test tools/test_ai_search.mjs (no packages, credentials or live writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker, { validateFilter, MODEL_CHAIN } from '../cloudflare_worker/worker.js';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/application\/ld\+json/.test(m[1])).map(m => m[2]);
const source = scripts.find(s => s.includes('function getFilteredProperties()'));
const blank = () => ({
  property_id: null, districts: [], street_keywords: [], categories: [],
  min_price_billion: null, max_price_billion: null, min_width_m: null, min_area_m2: null,
  min_floors: null, has_basement: null, min_rent_million: null,
  has_rental_income: null, only_discounted: null
});
const dataContext = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(new URL('properties_data.js', root), 'utf8'), dataContext);
const records = dataContext.window.__NHATOSG_DATA__.records;
function fn(name) {
  const match = new RegExp(`    (?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `function ${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
function pageContext(fetchImpl = async () => { throw new Error('offline'); }) {
  const els = new Map();
  const element = id => {
    if (!els.has(id)) els.set(id, {
      value: id === 'sortFilter' ? 'PRIORITY' : id === 'smartSearchInput' ? '' : 'ALL',
      textContent: '', innerHTML: '', attributes: {},
      classList: { add() {}, remove() {}, toggle() {} }, scrollIntoView() {},
      setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; }
    });
    return els.get(id);
  };
  const ctx = vm.createContext({
    window: {}, document: { getElementById: element }, console,
    setTimeout, clearTimeout, AbortController, fetch: fetchImpl, propertiesData: records
  });
  vm.runInContext(`let currentParsedQueryFilter = null, currentParsedQueryRaw = '', smartSearchController = null;
    let smartSearchSequence = 0, currentPage = 1, extraLoadedCount = 0, hotCurrentPage = 1;
    const _metricsCache = new Map(); let renderCalls = 0;
    function renderAll() { renderCalls++; } function populateWardOptions() {} function renderQuickDistrictBar() {}
    const AI_SEARCH_URL = 'https://nhatosg-search-ai.nhatosg.workers.dev/';
    const AI_CATEGORY_LABELS = {building:'Tòa Văn Phòng',hotel_chdv:'Tòa CHDV / Khách Sạn',nha_pho:'Nhà Phố Mặt Tiền',biet_thu:'Biệt Thự / Dinh Thự',quy_dat:'Quỹ Đất Xây Cao Tầng'};
  `, ctx);
  for (const name of ['removeVietnameseTones', 'parseVietnameseFloorNumber', 'parseCashflowMonthlyMillion',
    'computeMetrics', 'resolveCategoryName', 'extractWidthMeters', 'parseNaturalLanguageQuery',
    'adaptAiSearchFilter', 'getFilteredProperties', 'esc', 'cancelSmartSearch', 'clearAllFilters',
    'resetPageAndRender', 'runSmartSearch']) vm.runInContext(fn(name), ctx);
  return { ctx, element, run: text => vm.runInContext(text, ctx), apply: filter => {
    element('smartSearchInput').value = 'fixture query';
    ctx.fixtureFilter = filter;
    return vm.runInContext(`currentParsedQueryRaw='fixture query'; currentParsedQueryFilter=adaptAiSearchFilter(fixtureFilter); getFilteredProperties()`, ctx);
  } };
}
let ip = 0;
function request(query = 'building Tân Bình', overrides = {}) {
  return new Request('https://fixture.test/', {
    method: 'POST', headers: { Origin: 'https://nhatosg.com.vn', 'Content-Type': 'application/json', 'CF-Connecting-IP': `fixture-${++ip}` },
    body: JSON.stringify({ query }), ...overrides
  });
}
async function withGoogle(fake, task) {
  const old = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await task(); } finally { globalThis.fetch = old; }
}
const googleSuccess = filter => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(filter) }] } }] }));

test('all inline website scripts compile; exactly one filter and render pipeline', () => {
  scripts.forEach(s => new vm.Script(s));
  assert.equal((source.match(/function getFilteredProperties\(/g) || []).length, 1);
  assert.equal((source.match(/function renderAll\(/g) || []).length, 1);
  assert.equal(records.length, 240);
});
test('strict Worker and client validation agree for every schema field', () => {
  const page = pageContext();
  const good = { ...blank(), max_price_billion: 150, has_basement: false };
  assert.ok(validateFilter(good)); page.ctx.payload = good;
  assert.ok(page.run('adaptAiSearchFilter(payload)'));
  for (const bad of [null, [], {}, { ...good, extra: 1 }, { ...good, max_price_billion: '150' },
    { ...good, min_floors: 2.5 }, { ...good, has_basement: 1 }, { ...good, has_basement: 'false' },
    { ...good, categories: ['arbitrary'] }, { ...good, districts: ['<img>'] },
    { ...good, street_keywords: ['<img src=x onerror=alert(1)>'] }, { ...good, property_id: '0528' },
    { ...good, min_price_billion: 160 }, { ...good, min_width_m: -1 }]) {
    assert.equal(validateFilter(bad), null); page.ctx.payload = bad;
    assert.equal(page.run('adaptAiSearchFilter(payload)'), null);
  }
});
test('CORS rejects missing/spoofed Origin before Google call', async () => {
  await withGoogle(() => { throw new Error('must not call Google'); }, async () => {
    for (const Origin of ['', 'https://evil.test', 'https://nhatosg.com.vn.evil.test', 'http://localhost.evil.test', 'https://nhatosg.com.vn:999']) {
      const r = await worker.fetch(request('x', { headers: { Origin, 'Content-Type': 'application/json' } }), {});
      assert.equal(r.status, 403); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    }
    for (const Origin of ['https://nhatosg.com.vn', 'https://www.nhatosg.com.vn', 'http://localhost:54321', 'http://127.0.0.1:54321']) {
      const r = await worker.fetch(new Request('https://fixture.test', { method: 'OPTIONS', headers: { Origin } }), {});
      assert.equal(r.status, 204); assert.equal(r.headers.get('Access-Control-Allow-Origin'), Origin);
    }
  });
});
test('POST, JSON, query type/length and bounded body gates', async () => {
  for (const [req, code, reason] of [
    [new Request('https://fixture.test', { headers: { Origin: 'https://nhatosg.com.vn' } }), 405, 'METHOD_NOT_ALLOWED'],
    [request('x', { headers: { Origin: 'https://nhatosg.com.vn' } }), 415, 'INVALID_CONTENT_TYPE'],
    [request('', {}), 400, 'QUERY_LENGTH_EXCEEDED'], [request(' '.repeat(5)), 400, 'QUERY_LENGTH_EXCEEDED'],
    [request('x'.repeat(201)), 400, 'QUERY_LENGTH_EXCEEDED'], [request(123), 400, 'INVALID_QUERY'],
    [request('x', { body: '{' }), 400, 'INVALID_JSON'], [request('x'.repeat(3000)), 413, 'REQUEST_TOO_LARGE']
  ]) { const r = await worker.fetch(req, {}); assert.equal(r.status, code); assert.equal((await r.json()).reason, reason); }
});
test('rate gate stops the 21st request from one isolate/IP', async () => {
  for (let i = 0; i < 21; i++) {
    const req = request('x', { headers: { Origin: 'https://nhatosg.com.vn', 'Content-Type': 'application/json', 'CF-Connecting-IP': 'quota-fixture' } });
    const r = await worker.fetch(req, {}); assert.equal(r.status, i === 20 ? 429 : 503);
  }
});
test('Google gets only query, uses key header, chain order, one signal and strict schema', async () => {
  const calls = [], filter = { ...blank(), districts: ['Tân Bình'], categories: ['building'], max_price_billion: 200 };
  await withGoogle(async (url, init) => {
    calls.push({ url, init });
    return calls.length < 3 ? new Response('', { status: calls.length === 1 ? 404 : 403 }) : googleSuccess(filter);
  }, async () => {
    const r = await worker.fetch(request(), { GEMINI_API_KEY: 'test-key' });
    assert.deepEqual((await r.json()).filter, filter); assert.equal(calls.length, 3);
    calls.forEach((c, i) => {
      assert.ok(c.url.includes(MODEL_CHAIN[i])); assert.ok(!c.url.includes('test-key'));
      assert.equal(c.init.headers['x-goog-api-key'], 'test-key');
      const payload = JSON.parse(c.init.body);
      assert.deepEqual(payload.contents, [{ role: 'user', parts: [{ text: 'building Tân Bình' }] }]);
      assert.ok(payload.generationConfig.responseSchema.required.includes('only_discounted'));
      assert.equal(c.init.signal, calls[0].init.signal);
    });
  });
});
test('provider errors, 429, missing key and invalid/empty model output fall back without leaking errors', async () => {
  assert.equal((await worker.fetch(request(), {})).status, 503);
  for (const result of [() => new Response('sensitive provider body', { status: 429 }),
    () => googleSuccess({ wrong: true }), () => googleSuccess(blank()),
    () => new Response('{}'), () => { throw new Error('secret provider error'); }]) {
    await withGoogle(result, async () => {
      const body = await (await worker.fetch(request(), { GEMINI_API_KEY: 'test-key' })).text();
      assert.equal(JSON.parse(body).fallback, true); assert.ok(!/secret|sensitive|test-key/.test(body));
    });
  }
});
test('real six-second abort budget prevents a hung provider', async () => {
  await withGoogle((_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), async () => {
    const start = Date.now();
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const result = await (await worker.fetch(request(), { GEMINI_API_KEY: 'test-key' })).json();
      assert.equal(result.reason, 'AI_TIMEOUT'); assert.ok(Date.now() - start >= 5900); assert.ok(Date.now() - start < 7500);
    } finally { clearInterval(keepAlive); }
  });
});
test('real inventory filters: ID; district OR; category OR; street OR; all numeric conditions', () => {
  const p = pageContext();
  const id = p.apply({ ...blank(), property_id: 'NSG-0528' }); assert.equal(id.length, 1);
  const exact = p.apply({ ...blank(), districts: ['Tân Bình'], categories: ['building'], street_keywords: ['Hoàng Việt'],
    min_price_billion: 160, max_price_billion: 170, min_width_m: 12, min_area_m2: 240, min_floors: 9,
    has_basement: true, min_rent_million: 500, has_rental_income: true, only_discounted: true });
  assert.ok(exact.some(x => x.property_id === 'NSG-0528'));
  const multi = p.apply({ ...blank(), districts: ['Quận 1', 'Quận 3'], categories: ['hotel_chdv', 'nha_pho'] });
  assert.ok(multi.length > 0); assert.ok(multi.every(x => ['Quận 1', 'Quận 3'].includes(x.public_location.district)));
  const streets = p.apply({ ...blank(), street_keywords: ['Hoàng Việt', 'Hai Bà Trưng'] });
  assert.ok(streets.some(x => x.public_location.street.includes('Hoàng Việt')));
  assert.ok(streets.some(x => x.public_location.street.includes('Hai Bà Trưng')));
});
test('hidden prices cannot be inferred via AI numeric filters or concierge text', async () => {
  const p = pageContext(async () => new Response(JSON.stringify({ success: true, filter: { ...blank(), property_id: 'NSG-0664' } })));
  const list = p.apply({ ...blank(), max_price_billion: 1000000 });
  assert.ok(!list.some(r => r.is_price_masked));
  p.element('smartSearchInput').value = 'NSG-0664';
  await p.run('runSmartSearch()');
  assert.ok(p.element('conciergeText').textContent.includes('Giá liên hệ'));
});
test('boolean false is retained, non-discount UPDATE is not discounted, floors do not guess', () => {
  const p = pageContext();
  p.ctx.propertiesData = [
    { property_id: 'NSG-9001', category: 'Nhà Phố Mặt Tiền', event_type: 'UPDATE', public_location: {}, specs: { structure: '4 Tầng', dimensions: '6x10', cashflow_monthly_million: 0 }, pricing: { current_price_billion: 50, initial_asking_billion: 50 } },
    { property_id: 'NSG-9002', category: 'Tòa CHDV / Khách Sạn', event_type: 'STANDARD', public_location: {}, specs: { structure: '1 Hầm + 8 Tầng', cashflow_monthly_million: 100 }, pricing: { current_price_billion: 40, initial_asking_billion: 60 } }
  ];
  assert.equal(p.apply({ ...blank(), has_basement: false, has_rental_income: false, only_discounted: false })[0].property_id, 'NSG-9001');
  assert.equal(p.apply({ ...blank(), only_discounted: true })[0].property_id, 'NSG-9002');
  assert.equal(p.apply({ ...blank(), categories: ['building'] }).length, 0);
  assert.equal(p.apply({ ...blank(), min_floors: 9 }).length, 0);
});
test('existing manual dropdowns still intersect with AI results', () => {
  const p = pageContext(); p.element('districtFilter').value = 'Quận 1';
  assert.equal(p.apply({ ...blank(), districts: ['Tân Bình'] }).length, 0);
});
test('district Quận 1 never matches Quận 10/11/12 or a ward containing its name', () => {
  const p = pageContext();
  p.ctx.propertiesData = ['Quận 1', 'Quận 10', 'Quận 11', 'Quận 12'].map((district, i) => ({
    property_id: `NSG-910${i}`, category: 'Nhà Phố Mặt Tiền', public_location: { district, ward: 'Quận 1' }, specs: {}, pricing: {}
  }));
  const list = p.apply({ ...blank(), districts: ['Quận 1'] });
  assert.equal(list.length, 1); assert.equal(list[0].public_location.district, 'Quận 1');
});
test('legacy search and all manual dropdowns give the same IDs as baseline', () => {
  const p = pageContext();
  // Baseline is Git, not a mutable backup; git is used read-only here.
  return import('node:child_process').then(({ execFileSync }) => {
    const baseline = execFileSync('git', ['show', '5f6d2c754786fe2bf765a8a23badd75624dc03dc:index.html'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', maxBuffer: 2000000 });
    const start = baseline.indexOf('    function getFilteredProperties(');
    const oldFilter = baseline.slice(start, baseline.indexOf('\n    }', start) + 6).replace('function getFilteredProperties(', 'function baselineFilteredProperties(');
    vm.runInContext(oldFilter, p.ctx);
    for (const [id, values] of [
      ['smartSearchInput', ['', 'NSG-0528', 'Tân Bình', 'dưới 50 tỷ', 'Hoàng Việt']],
      ['segmentFilter', ['ALL', '20_50', '50_100', 'OVER_100']],
      ['typeFilter', ['ALL', 'Tòa Văn Phòng', 'Nhà Phố Mặt Tiền']],
      ['districtFilter', ['ALL', 'Quận 1', 'Tân Bình']], ['eventFilter', ['ALL', 'NEW', 'UPDATE']],
      ['widthFilter', ['ALL', 'MIN_5', 'MIN_7', 'MIN_10']],
      ['featureFilter', ['ALL', 'HAS_BASEMENT', 'CORNER_2MT', 'HIGH_CASHFLOW']],
      ['sortFilter', ['PRIORITY', 'DISCOUNT_DESC', 'YIELD_DESC', 'PRICE_ASC', 'PRICE_DESC']]
    ]) {
      for (const value of values) {
        p.element(id).value = value;
        assert.equal(p.run('JSON.stringify(getFilteredProperties().map(p=>p.property_id))'),
          p.run('JSON.stringify(baselineFilteredProperties().map(p=>p.property_id))'), `${id}=${value}`);
      }
      p.element(id).value = id === 'sortFilter' ? 'PRIORITY' : id === 'smartSearchInput' ? '' : 'ALL';
    }
  });
});
test('runSmartSearch sends only query and uses the existing renderer, no inventory upload', async () => {
  let call;
  const p = pageContext(async (url, init) => { call = { url, init }; return new Response(JSON.stringify({ success: true, filter: { ...blank(), property_id: 'NSG-0528' } })); });
  p.element('smartSearchInput').value = 'tìm NSG-0528'; await p.run('runSmartSearch()');
  assert.deepEqual(JSON.parse(call.init.body), { query: 'tìm NSG-0528' }); assert.equal(call.init.credentials, 'omit');
  assert.equal(p.run('getFilteredProperties().length'), 1); assert.ok(p.run('renderCalls') >= 1);
});
test('AI 404/offline/invalid response preserves local search; >200 chars never sent', async () => {
  for (const fake of [async () => new Response('', { status: 404 }), async () => { throw new Error('offline'); },
    async () => new Response(JSON.stringify({ success: true, filter: { bad: 'value' } }))]) {
    const p = pageContext(fake); p.element('smartSearchInput').value = 'NSG-0528';
    await p.run('runSmartSearch()'); assert.equal(p.run('getFilteredProperties()[0].property_id'), 'NSG-0528');
  }
  const p = pageContext(() => { assert.fail('long query sent'); }); p.element('smartSearchInput').value = 'x'.repeat(201);
  await p.run('runSmartSearch()');
});
test('out-of-order AI response cannot replace a newer search', async () => {
  const pending = [];
  const p = pageContext(() => new Promise(resolve => pending.push(resolve)));
  p.element('smartSearchInput').value = 'NSG-0528'; const first = p.run('runSmartSearch()');
  p.element('smartSearchInput').value = 'NSG-0741'; const second = p.run('runSmartSearch()');
  pending[1](new Response(JSON.stringify({ success: true, filter: { ...blank(), property_id: 'NSG-0741' } }))); await second;
  pending[0](new Response(JSON.stringify({ success: true, filter: { ...blank(), property_id: 'NSG-0528' } }))); await first;
  assert.equal(p.run('getFilteredProperties()[0].property_id'), 'NSG-0741');
});
test('clear cancels pending AI and restores all 240 properties', async () => {
  let resolve;
  const p = pageContext(() => new Promise(r => { resolve = r; }));
  p.element('smartSearchInput').value = 'NSG-0528'; const promise = p.run('runSmartSearch()'); p.run('clearAllFilters()');
  resolve(new Response(JSON.stringify({ success: true, filter: { ...blank(), property_id: 'NSG-0528' } }))); await promise;
  assert.equal(p.run('getFilteredProperties().length'), 240);
});
test('client aborts a stalled Worker at 6.5s and keeps local results', async () => {
  const p = pageContext((_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  p.element('smartSearchInput').value = 'NSG-0528'; const start = Date.now();
  await p.run('runSmartSearch()');
  assert.ok(Date.now() - start >= 6400 && Date.now() - start < 8000);
  assert.equal(p.run('getFilteredProperties()[0].property_id'), 'NSG-0528');
  assert.equal(p.element('smartSearchInput').attributes['aria-busy'], undefined);
});
