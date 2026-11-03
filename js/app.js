// The census website: routing, search, surface pages, statistics and the two text pages.
// Unfiltered browsing and surface pages read small row files; filters and sorting use DuckDB
// in the browser, which is only loaded when first needed.

import { decodeKey, parseFibres, componentCycles, normaliseConfiguration, typeOrder,
         fibreFactors, polyMul, p2FromData, splitP2, rowFromCsv } from './census_math.mjs';
import { highlightMagma } from './magma-highlight.mjs';

const REPO = 'https://github.com/Census-of-elliptic-fibrations/Census-of-elliptic-and-quasi-elliptic-K3-surfaces-over-F2';
const DUCKDB = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm';
const PAGE_SIZE = 50;
const ROWS_PER_FILE = 1000;
const DOWNLOAD_CAP = 100000;

const view = document.getElementById('view');
let manifest = null;

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  // Builds a DOM element.  Input: tag name, attributes ('html' sets innerHTML, on* adds a
  // listener), children (strings or elements).  Output: the element.
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) el.append(c);
  return el;
}
const tex = (s, display = false) => katex.renderToString(s, { displayMode: display, throwOnError: false });
const T = (s, display = false) => h('span', { html: tex(s, display) });
const fmt = (n) => Number(n).toLocaleString('en');

const a1Tex = (a) => a.replace(/\*/g, '').replace(/\^(\d+)/g, '^{$1}');
function typeTex(t) {
  const m = t.match(/^I(\d+)(\*?)$/);
  if (m) return `\\mathrm{I}_{${m[1]}}${m[2] ? '^{*}' : ''}`;
  return `\\mathrm{${t.replace('*', '')}}${t.endsWith('*') ? '^{*}' : ''}`;
}
const configTex = (c) => c.split(', ').map(p => {
  const m = p.match(/^(\d+) (.+)$/);
  return m ? `${m[1]}\\,${typeTex(m[2])}` : typeTex(p);
}).join(',\\ ');
const torsionTex = (g) => g === 'trivial' ? '0' : g.replace(/Z\//g, '\\mathbf{Z}/').replace(/ x /g, ' \\times ');
function torsionOrder(g) {
  // The order of a torsion group.  Input: a label such as "trivial" or "Z/2 x Z/4".  Output: an integer.
  return g === 'trivial' ? 1 : g.split(' x ').reduce((n, part) => n * Number(part.slice(2)), 1);
}
const byTorsionOrder = (a, b) => torsionOrder(a) - torsionOrder(b) || a.localeCompare(b);
function polyTex(c, v = 'u') {
  let out = '';
  c.forEach((a, i) => {
    if (!a) return;
    const abs = Math.abs(a), mon = i === 0 ? '' : i === 1 ? v : `${v}^{${i}}`;
    const body = mon && abs === 1 ? mon : `${abs}${mon}`;
    out += out ? (a < 0 ? ' - ' : ' + ') + body : (a < 0 ? '-' : '') + body;
  });
  return out || '0';
}
function polyTerms(c, v = 'u') {
  // The terms of a polynomial, each with its sign.
  //   Input:  c, a coefficient list, constant term first
  //   Output: a list of LaTeX strings, such as ['1', '- 22u', '+ 220u^{2}']
  const out = [];
  c.forEach((a, i) => {
    if (!a) return;
    const abs = Math.abs(a), mon = i === 0 ? '' : i === 1 ? v : `${v}^{${i}}`;
    const body = mon && abs === 1 ? mon : `${abs}${mon}`;
    out.push(out.length ? (a < 0 ? '- ' : '+ ') + body : (a < 0 ? '-' : '') + body);
  });
  return out.length ? out : ['0'];
}
function factorPieces({ algebraic, rest }) {
  // A factored polynomial as pieces that can be broken across lines.
  //   Input:  the result of splitP2
  //   Output: a list of LaTeX strings; ['1'] when there are no factors
  const pieces = [];
  const add = (poly, mult) => {
    const t = polyTerms(poly);
    t[0] = '(' + t[0];
    t[t.length - 1] += ')' + (mult > 1 ? `^{${mult}}` : '');
    pieces.push(...t);
  };
  algebraic.forEach(a => add(a.poly, a.mult));
  if (rest.length > 1) add(rest, 1);
  return pieces.length ? pieces : ['1'];
}
function brokenLines(pieces, width = 90) {
  // Joins pieces into lines of an aligned display.
  //   Input:  pieces, LaTeX strings; width, the longest line in characters of LaTeX
  //   Output: a LaTeX string, with each later line indented under the first
  const lines = [];
  let line = '';
  for (const p of pieces) {
    if (line && line.length + p.length + 1 > width) { lines.push(line); line = p; }
    else line = line ? line + ' ' + p : p;
  }
  lines.push(line);
  return lines.join(String.raw`\\ &\quad `);
}
const heightText = (x) => x === null || x === undefined ? '∞' : String(x);

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`could not load ${path} (${r.status})`);
  return r.json();
}
async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`could not load ${path} (${r.status})`);
  return r.text();
}
const getManifest = async () => manifest ||= await fetchJson('data/manifest.json');

// ---------------------------------------------------------------------------------------
// Row files: reading surfaces without the search engine
// ---------------------------------------------------------------------------------------

let firstKeysPromise = null;
const firstKeys = () => firstKeysPromise ||= fetchJson('data/rows/index.json');
const shardCache = new Map();
function loadShard(i) {
  // The surfaces of one row file.  Input: its number.  Output: a promise of row objects.
  if (!shardCache.has(i)) {
    shardCache.set(i, fetchText(`data/rows/${String(i).padStart(5, '0')}.csv`).then(text =>
      text.trim().split('\n').map(line => rowFromCsv(line.split(',')))));
  }
  return shardCache.get(i);
}
async function findSurface(key) {
  // One surface by key.  Input: an integer.  Output: its row object, or null if it has no row.
  const first = await firstKeys();
  let lo = 0, hi = first.length - 1;
  if (key < first[0]) return null;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (first[mid] <= key) lo = mid; else hi = mid - 1; }
  return (await loadShard(lo)).find(r => r.key === key) || null;
}

// ---------------------------------------------------------------------------------------
// The search engine
// ---------------------------------------------------------------------------------------

let enginePromise = null;
function engine() {
  // DuckDB in the browser, with the views surfaces and fibres.  Output: a promise of a connection.
  return enginePromise ||= (async () => {
    const duckdb = await import(DUCKDB);
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    const conn = await db.connect();
    const attach = async (name) => {
      await db.registerFileURL(name + '.parquet', new URL('data/' + name + '.parquet', location.href).href, duckdb.DuckDBDataProtocol.HTTP, false);
      await conn.query(`CREATE VIEW ${name} AS SELECT * FROM '${name}.parquet'`);
    };
    await attach('surfaces');
    conn.useFibres = () => fibresReady ||= attach('fibres');
    window.__censusEngineReady = true;
    return conn;
  })();
}
let fibresReady = null;       // the fibre file is only downloaded when a fibre filter is used
const sqlRows = async (conn, sql) => (await conn.query(sql)).toArray().map(r => r.toJSON());

// ---------------------------------------------------------------------------------------
// Search: what can be filtered and shown
// ---------------------------------------------------------------------------------------

const A1 = [['zero', '0'], ['s2', 's^2'], ['st', 's*t'], ['irr', 's^2 + s*t + t^2']];
const RANGES = [
  ['analytic_rank', 'Rank of \\(E(\\mathbf F_2(T))\\)'], ['rank_geom', 'Rank of \\(E(\\overline{\\mathbf F}_2(T))\\)'], ['n_singular', 'Singular fibres'], ['n_reducible', 'Reducible fibres'],
  ['n_places', 'Bad places'], ['L_degree', 'Degree of \\(L\\)'], ['rho_f2', '\\(\\rho(X_{\\mathbf F_2})\\)'],
  ['rho_geom', '\\(\\rho(X_{\\overline{\\mathbf F}_2})\\)'], ['height', 'Height (finite)'],
  ['br_disc', '\\(\\#\\mathrm{Br}\\cdot|\\mathrm{disc}\\,\\mathrm{NS}|\\)'],
  ['pts_f2', '\\(\\#X(\\mathbf F_2)\\)'], ['pts_f4', '\\(\\#X(\\mathbf F_4)\\)'], ['pts_f8', '\\(\\#X(\\mathbf F_8)\\)'],
  ['pts_f16', '\\(\\#X(\\mathbf F_{16})\\)'], ['pts_f32', '\\(\\#X(\\mathbf F_{32})\\)'],
];
const COLUMNS = [
  ['key', 'Key', r => h('a', { href: `#/surface/${r.key}` }, String(r.key)), true],
  ['a1', '\\(a_1\\)', r => T(a1Tex(r.a1)), true],
  ['config', 'Singular fibres', r => T(configTex(r.config)), true],
  ['torsion', 'Torsion', r => T(torsionTex(r.torsion)), true],
  ['analytic_rank', 'Rank of \\(E(\\mathbf F_2(T))\\)', r => r.analytic_rank, true],
  ['rank_geom', 'Rank of \\(E(\\overline{\\mathbf F}_2(T))\\)', r => r.rank_geom, true],
  ['rho_f2', '\\(\\rho(X_{\\mathbf F_2})\\)', r => r.rho_f2, true],
  ['rho_geom', '\\(\\rho(X_{\\overline{\\mathbf F}_2})\\)', r => r.rho_geom, true],
  ['height', 'Height', r => heightText(r.height), true],
  ['br_disc', '\\(\\#\\mathrm{Br}\\cdot|\\mathrm{disc}\\,\\mathrm{NS}|\\)', r => fmt(r.br_disc), true],
  ['n_singular', 'Singular', r => r.n_singular, false],
  ['n_reducible', 'Reducible', r => r.n_reducible, false],
  ['n_places', 'Bad places', r => r.n_places, false],
  ['L_degree', '\\(\\deg L\\)', r => r.L_degree, false],
  ['L_sign', 'Sign of \\(L\\)', r => r.L_sign > 0 ? '+1' : '−1', false],
  ['zeta_sign', 'Sign of \\(P_2\\)', r => r.zeta_sign > 0 ? '+1' : '−1', false],
  ['pts_f2', '\\(\\#X(\\mathbf F_2)\\)', r => fmt(r.pts_f2), false],
  ['pts_f4', '\\(\\#X(\\mathbf F_4)\\)', r => fmt(r.pts_f4), false],
  ['pts_f8', '\\(\\#X(\\mathbf F_8)\\)', r => fmt(r.pts_f8), false],
  ['pts_f16', '\\(\\#X(\\mathbf F_{16})\\)', r => fmt(r.pts_f16), false],
  ['pts_f32', '\\(\\#X(\\mathbf F_{32})\\)', r => fmt(r.pts_f32), false],
];
const LEFT = new Set(['key', 'a1', 'config', 'torsion']);
const defaultCols = COLUMNS.filter(c => c[3]).map(c => c[0]);

function labelNode(text) {
  // A label that may contain \( ... \) mathematics.  Output: a span.
  const s = h('span');
  text.split(/\\\((.*?)\\\)/).forEach((part, i) => s.append(i % 2 ? T(part) : part));
  return s;
}

function buildWhere(p) {
  // The SQL condition of a search.  Every value is checked or converted first, because searches
  // come from links.  Input: URLSearchParams.  Output: a SQL string, or '' when unfiltered.
  const out = [];
  const a1 = (p.get('a1') || '').split(',').map(x => A1.find(a => a[0] === x)).filter(Boolean);
  if (a1.length && a1.length < A1.length) out.push(`a1 IN (${a1.map(a => `'${a[1]}'`).join(',')})`);
  for (const [col] of RANGES) {
    const lo = parseInt(p.get(col + '_min'), 10), hi = parseInt(p.get(col + '_max'), 10);
    if (Number.isFinite(lo)) out.push(`${col} >= ${lo}`);
    if (Number.isFinite(hi)) out.push(`${col} <= ${hi}`);
  }
  const torsion = p.get('torsion');
  if (torsion && /^(trivial|Z\/\d+( x Z\/\d+)?)$/.test(torsion)) out.push(`torsion = '${torsion}'`);
  for (const col of ['L_sign', 'zeta_sign']) { const v = p.get(col); if (v === '1' || v === '-1') out.push(`${col} = ${v}`); }
  if (p.get('ss') === '1') out.push('height IS NULL');
  if (p.get('ss') === '0') out.push('height IS NOT NULL');
  if (p.get('ord') === '1') out.push('height = 1');
  if (p.get('ord') === '0') out.push('(height IS NULL OR height > 1)');
  const config = p.get('config') && normaliseConfiguration(p.get('config'));
  if (config) out.push(`config = '${config}'`);
  const agg = p.get('count') === 'places' ? 'COUNT(*)' : 'SUM(deg)';
  for (const raw of p.getAll('fib')) {
    const [type, deg, f, c, min] = raw.split('|');
    const conds = [];
    if (type && /^(I\d+\*?|II|III|IV)\*?$/.test(type)) conds.push(`type = '${type}'`);
    for (const [name, v] of [['deg', deg], ['f', f], ['c', c]]) {
      const n = parseInt(v, 10); if (Number.isFinite(n)) conds.push(`${name} = ${n}`);
    }
    const m = Math.max(parseInt(min, 10) || 1, 1);
    if (conds.length) out.push(`key IN (SELECT key FROM fibres WHERE ${conds.join(' AND ')} GROUP BY key HAVING ${agg} >= ${m})`);
  }
  return out.join(' AND ');
}

const parseHashParams = (qs) => new URLSearchParams(qs || '');
const goSearch = (p) => { location.hash = '#/search?' + p.toString(); };

// ---------------------------------------------------------------------------------------
// Search: the page
// ---------------------------------------------------------------------------------------

let searchToken = 0;

function filterForm(p, types, torsions) {
  const form = h('form', { id: 'filters-form', onsubmit: (e) => { e.preventDefault(); goSearch(readForm(form, p)); } });

  form.append(h('fieldset', {}, h('legend', {}, labelNode('\\(a_1\\) class')),
    h('div', { class: 'checks' }, A1.map(([id, form_]) => {
      const sel = (p.get('a1') || '').split(',');
      return h('label', {}, h('input', { type: 'checkbox', name: 'a1', value: id, id: 'f-a1-' + id, checked: sel.includes(id) }), T(a1Tex(form_)));
    }))));

  const select = (name, label, options) => h('label', { class: 'field field-select' }, labelNode(label),
    h('select', { name, id: 'f-' + name, value: null },
      options.map(([v, t]) => h('option', { value: v, ...(p.get(name) === v ? { selected: true } : {}) }, t))));

  form.append(h('fieldset', {}, h('legend', {}, 'Mordell–Weil and special classes'),
    select('torsion', 'Torsion', [['', 'Any'], ...torsions.map(t => [t, t.replace(/ x /g, ' × ')])]),
    select('ss', 'Supersingular', [['', 'Any'], ['1', 'Yes'], ['0', 'No']]),
    select('ord', 'Ordinary', [['', 'Any'], ['1', 'Yes'], ['0', 'No']]),
    select('L_sign', 'Sign of \\(L\\)', [['', 'Any'], ['1', '+1'], ['-1', '−1']]),
    select('zeta_sign', 'Sign of \\(P_2\\)', [['', 'Any'], ['1', '+1'], ['-1', '−1']])));

  form.append(h('fieldset', {}, h('legend', {}, 'Ranges (from, to)'),
    RANGES.map(([col, label]) => h('div', { class: 'field' }, labelNode(label),
      h('input', { type: 'number', min: 0, name: col + '_min', id: `f-${col}-min`, 'aria-label': 'minimum', value: p.get(col + '_min') || '' }),
      h('input', { type: 'number', min: 0, name: col + '_max', id: `f-${col}-max`, 'aria-label': 'maximum', value: p.get(col + '_max') || '' })))));

  // Per-fibre rows
  const rowsHost = h('div', { id: 'fibre-rows' });
  const addRow = (raw = '||||') => {
    const [type, deg, f, c, min] = raw.split('|');
    const row = h('div', { class: 'fibre-row' },
      h('label', {}, 'Type', h('select', { name: 'fib_type' }, h('option', { value: '' }, 'Any'),
        types.map(t => h('option', { value: t, ...(t === type ? { selected: true } : {}) }, t)))),
      h('label', {}, 'deg', h('input', { type: 'number', min: 1, name: 'fib_deg', value: deg })),
      h('label', {}, 'f', h('input', { type: 'number', min: 0, name: 'fib_f', value: f })),
      h('label', {}, 'c', h('input', { type: 'number', min: 1, name: 'fib_c', value: c })),
      h('label', {}, 'at least', h('input', { type: 'number', min: 1, name: 'fib_min', value: min })),
      h('button', { type: 'button', 'aria-label': 'Remove this fibre condition', onclick: () => row.remove() }, '×'));
    rowsHost.append(row);
  };
  p.getAll('fib').forEach(addRow);
  form.append(h('fieldset', {}, h('legend', {}, 'Singular fibres'),
    h('p', { class: 'hint' }, 'Each row asks for fibres that meet all of its conditions at once. A surface must satisfy every row.'),
    rowsHost,
    h('div', { class: 'actions', style: 'margin-top:4px' }, h('button', { type: 'button', id: 'add-fibre', onclick: () => addRow() }, 'Add a fibre condition')),
    h('label', { class: 'field field-select', style: 'margin-top:8px' }, 'Count fibres',
      h('select', { name: 'count', id: 'f-count' },
        h('option', { value: '' }, 'Over the closure'),
        h('option', { value: 'places', ...(p.get('count') === 'places' ? { selected: true } : {}) }, 'As places of F2(T)'))),
    h('label', { style: 'display:grid;gap:2px;font-size:.92rem;margin-top:4px' }, 'Exact configuration',
      h('input', { type: 'text', name: 'config', id: 'f-config', placeholder: 'e.g. 16 I1, I4, IV', value: p.get('config') || '' }))));

  form.append(h('div', { class: 'actions' },
    h('button', { class: 'primary', type: 'submit', id: 'run-search' }, 'Search'),
    h('button', { type: 'button', id: 'reset-search', onclick: () => goSearch(new URLSearchParams()) }, 'Clear')));
  return form;
}

function readForm(form, old) {
  const f = new FormData(form), p = new URLSearchParams();
  const a1 = f.getAll('a1');
  if (a1.length) p.set('a1', a1.join(','));
  for (const name of ['torsion', 'ss', 'ord', 'L_sign', 'zeta_sign', 'count', 'config']) { const v = f.get(name); if (v) p.set(name, v.trim()); }
  for (const [col] of RANGES) for (const s of ['_min', '_max']) { const v = f.get(col + s); if (v !== '' && v !== null) p.set(col + s, v); }
  const [ty, de, ff, cc, mi] = ['fib_type', 'fib_deg', 'fib_f', 'fib_c', 'fib_min'].map(n => f.getAll(n));
  ty.forEach((t, i) => { const raw = [t, de[i], ff[i], cc[i], mi[i]].join('|'); if (raw.replace(/\|/g, '')) p.append('fib', raw); });
  for (const k of ['sort', 'dir', 'cols']) if (old.get(k)) p.set(k, old.get(k));
  return p;
}

async function renderSearch(p) {
  const m = await getManifest();
  const types = [...m.kodairaTypes].sort((a, b) => typeOrder(a) - typeOrder(b));
  const results = h('section', { id: 'results', 'aria-live': 'polite' });
  const wide = window.matchMedia('(min-width: 901px)').matches;
  view.replaceChildren(
    h('h1', {}, 'Search the census'),
    h('div', { class: 'search-layout' },
      h('details', { class: 'filters', ...(wide || p.toString() ? { open: true } : {}) }, h('summary', {}, 'Filters'), filterForm(p, types, [...m.torsionGroups].sort(byTorsionOrder))),
      results));
  runSearch(p, results, m);
}

async function runSearch(p, host, m) {
  const token = ++searchToken;
  const where = buildWhere(p);
  const sortCol = COLUMNS.some(c => c[0] === p.get('sort')) ? p.get('sort') : 'key';
  const dir = p.get('dir') === 'desc' ? 'DESC' : 'ASC';
  const page = Math.max(parseInt(p.get('page'), 10) || 1, 1);
  const cols = (p.get('cols') || '').split(',').filter(c => COLUMNS.some(d => d[0] === c));
  const shown = COLUMNS.filter(c => (cols.length ? cols : defaultCols).includes(c[0]));
  const offset = (page - 1) * PAGE_SIZE;
  const t0 = performance.now();
  host.replaceChildren(h('p', { class: 'status', id: 'search-status' }, enginePromise || !(where || sortCol !== 'key' || dir === 'DESC')
    ? 'Searching…' : 'Downloading the search engine and the data (about 12 MB, or 25 MB with fibre filters). This happens once per visit; later searches are quick.'));
  try {
    let rows, total;
    if (!where && sortCol === 'key' && dir === 'ASC') {
      total = m.rows;
      rows = [];
      const start = offset, end = Math.min(offset + PAGE_SIZE, total);
      for (let s = Math.floor(start / ROWS_PER_FILE); s * ROWS_PER_FILE < end; s++) {
        const part = await loadShard(s);
        for (let i = 0; i < part.length; i++) {
          const pos = s * ROWS_PER_FILE + i;
          if (pos >= start && pos < end) rows.push(part[i]);
        }
      }
    } else {
      const conn = await engine();
      if (where.includes('FROM fibres')) await conn.useFibres();
      if (token !== searchToken) return;
      const w = where ? 'WHERE ' + where : '';
      total = where ? Number((await sqlRows(conn, `SELECT COUNT(*) AS n FROM surfaces ${w}`))[0].n) : m.rows;
      if (token !== searchToken) return;
      const nulls = dir === 'DESC' ? 'NULLS FIRST' : 'NULLS LAST';
      const keys = (await sqlRows(conn, `SELECT key FROM surfaces ${w} ORDER BY ${sortCol} ${dir} ${nulls}, key LIMIT ${PAGE_SIZE} OFFSET ${offset}`)).map(r => r.key);
      if (token !== searchToken) return;
      rows = [];
      if (keys.length) {
        const got = await sqlRows(conn, `SELECT * FROM surfaces WHERE key IN (${keys.join(',')})`);
        const byKey = new Map(got.map(r => [r.key, r]));
        rows = keys.map(k => byKey.get(k));
      }
    }
    if (token !== searchToken) return;
    const seconds = (performance.now() - t0) / 1000;
    window.__censusLastSearch = { total, seconds, where };
    drawResults(host, p, { rows, total, page, shown, sortCol, dir, seconds, where, m });
  } catch (err) {
    if (token !== searchToken) return;
    window.__censusLastError = String(err);
    host.replaceChildren(h('p', { class: 'error', role: 'alert' }, 'The search could not run: ' + (err.message || err) +
      '. Check your connection and try again. If it persists, try another browser.'));
  }
}

function drawResults(host, p, { rows, total, page, shown, sortCol, dir, seconds, where, m }) {
  const setParam = (changes) => {
    const q = new URLSearchParams(p);
    for (const [k, v] of Object.entries(changes)) { if (v === null) q.delete(k); else q.set(k, v); }
    goSearch(q);
  };
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const showing = total ? `${fmt((page - 1) * PAGE_SIZE + 1)}–${fmt(Math.min(page * PAGE_SIZE, total))}` : '0';

  const bar = h('div', { class: 'result-bar' },
    h('span', { class: 'count', id: 'result-count' }, `${fmt(total)} surface${total === 1 ? '' : 's'}`),
    h('span', { class: 'muted' }, `showing ${showing}`, where ? `, found in ${seconds < 0.1 ? 'under 0.1' : seconds.toFixed(1)} s` : ''),
    h('button', { type: 'button', id: 'copy-link', onclick: async (e) => {
      try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Link copied'; }
      catch { e.target.textContent = 'Copy the address bar instead'; }
    } }, 'Copy link to this search'),
    h('button', { type: 'button', id: 'download-csv', onclick: (e) => downloadCsv(e.target, where, sortCol, dir, total) }, 'Download CSV'));

  const colsPanel = h('details', { class: 'cols-panel' }, h('summary', {}, 'Columns'),
    h('div', { class: 'checks' }, COLUMNS.map(([id, label]) => h('label', {},
      h('input', { type: 'checkbox', id: 'col-' + id, checked: shown.some(s => s[0] === id), onchange: () => {
        const on = COLUMNS.filter(c => document.getElementById('col-' + c[0]).checked).map(c => c[0]);
        setParam({ cols: on.length ? on.join(',') : null, page: null });
      } }), labelNode(label)))));

  const thead = h('tr', {}, shown.map(([id, label]) => h('th', {
    class: LEFT.has(id) ? 'left' : null,
    'aria-sort': sortCol === id ? (dir === 'ASC' ? 'ascending' : 'descending') : 'none',
  }, h('button', { type: 'button', 'data-sort': id, onclick: () => setParam({ sort: id, dir: sortCol === id && dir === 'ASC' ? 'desc' : 'asc', page: null }) },
    labelNode(label), sortCol === id ? (dir === 'ASC' ? ' ▲' : ' ▼') : ''))));
  const tbody = h('tbody', {}, rows.map(r => h('tr', {}, shown.map(([id, , cell]) => {
    const v = cell(r);
    return h('td', { class: LEFT.has(id) ? 'left' : null }, typeof v === 'number' ? String(v) : v);
  }))));

  const pager = h('div', { class: 'pager' },
    h('button', { type: 'button', id: 'prev-page', disabled: page <= 1, onclick: () => setParam({ page: page - 1 }) }, 'Previous'),
    h('span', { class: 'muted' }, `Page ${fmt(page)} of ${fmt(pages)}`),
    h('button', { type: 'button', id: 'next-page', disabled: page >= pages, onclick: () => setParam({ page: page + 1 }) }, 'Next'));

  const nodes = [bar, colsPanel];
  if (!rows.length) nodes.push(h('p', { class: 'status' }, 'No surface in the census matches these filters.'));
  else nodes.push(h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'results-table' }, h('thead', {}, thead), tbody)), pager);
  if (m.missing) nodes.push(h('p', { class: 'hint' }, `${fmt(m.missing)} of the ${fmt(m.models)} surfaces have not been computed yet, so counts are incomplete.`));
  host.replaceChildren(...nodes);
}

async function downloadCsv(btn, where, sortCol, dir, total) {
  if (total > DOWNLOAD_CAP) {
    btn.textContent = `Too many rows: narrow to ${fmt(DOWNLOAD_CAP)} or fewer`;
    return;
  }
  const label = btn.textContent;
  btn.textContent = 'Preparing…'; btn.disabled = true;
  try {
    const conn = await engine();
    if (where.includes('FROM fibres')) await conn.useFibres();
    const rows = await sqlRows(conn, `SELECT * FROM surfaces ${where ? 'WHERE ' + where : ''} ORDER BY ${sortCol} ${dir}, key`);
    const names = rows.length ? Object.keys(rows[0]) : [];
    const quote = (v) => { const s = v === null || v === undefined ? (v === null ? 'inf' : '') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = [names.join(','), ...rows.map(r => names.map(n => quote(r[n])).join(','))].join('\n') + '\n';
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: 'census_search.csv' });
    document.body.append(a); a.click(); a.remove();
    btn.textContent = label;
  } catch (err) {
    btn.textContent = 'Download failed: ' + (err.message || err);
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------------------
// A surface's page
// ---------------------------------------------------------------------------------------

function equationTex(key) {
  const d = decodeKey(key);
  const form = (ms) => ms.map(([a, b]) => {
    const s = a === 0 ? '' : a === 1 ? 's' : `s^{${a}}`, t = b === 0 ? '' : b === 1 ? 't' : `t^{${b}}`;
    return s + t || '1';
  }).join(' + ');
  const term = (ms, mon) => {
    if (!ms.length) return null;
    return ms.length > 1 ? `(${form(ms)})\\,${mon}` : `${form(ms)}\\,${mon}`;
  };
  const left = ['y^2', term(d.a1, 'xy'), term(d.a3, 'y')].filter(Boolean).join(' + ');
  const right = ['x^3', term(d.a4, 'x'), d.a6.length ? form(d.a6) : null].filter(Boolean).join(' + ');
  return `${left} = ${right}`;
}

function magmaSnippet(key, p2) {
  // Magma code for a surface that uses only built-in functions, so nothing has to be loaded.
  //   Input:  key, the surface's key; p2, the coefficients of its P2
  //   Output: a string of Magma code
  const d = decodeKey(key);
  const form = (ms) => ms.length ? ms.map(([, e]) => e === 0 ? '1' : e === 1 ? 'T' : `T^${e}`).join(' + ') : '0';
  const p2Text = polyTerms(p2).map(t => t.replace(/^([+-] )?(-?\d+)u/, '$1$2*u').replace(/\^\{(\d+)\}/, '^$1')).join(' ');
  return `// Surface ${key}: built-in Magma functions only, nothing to load.
K<T> := RationalFunctionField(GF(2));    // T = t/s
E := EllipticCurve([ K | ${form(d.a1)}, 0, ${form(d.a3)}, ${form(d.a4)}, ${form(d.a6)} ]);

LocalInformation(E);       // <place, ord(Delta_min), f, c, Kodaira type> at each bad place
TorsionSubgroup(E);        // torsion of E(K)
LFunction(E);              // L(E/K, u)
AnalyticInformation(E);    // its first entry is the rank of E(K)

// P2 as shown on this page
Zu<u> := PolynomialRing(Integers());
P2 := ${p2Text};
Factorization(P2);         // its factors, irreducible over Z
Slopes(NewtonPolygon(ChangeRing(P2, pAdicRing(2, 500))));    // the 2-adic slopes give the height
ArtinTateFormula(Parent(P2) ! (u^22 * Evaluate(P2, 1/u)), 2, 1);    // rho(X/F_2) and #Br(X)*|disc NS(X)|`;
}

async function renderSurface(keyText) {
  const key = Number(keyText);
  if (!/^\d+$/.test(keyText) || key >= 2 ** 32) {
    view.replaceChildren(h('h1', {}, 'Not a census key'), h('p', {}, `“${keyText}” is not a census key. Keys are whole numbers below 2^32.`));
    return;
  }
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const m = await getManifest();
  const r = await findSurface(key);
  const back = h('p', {}, h('a', { href: '#/search' }, 'Back to search'));
  if (!r) {
    const missing = (await fetchText('data/missing_keys.txt')).split('\n').includes(String(key));
    view.replaceChildren(back, h('h1', {}, `Surface ${key}`),
      missing
        ? h('div', {}, h('p', { id: 'not-computed' }, 'This surface is in the census, but its invariants have not been computed yet.'),
            h('h2', {}, 'Weierstrass model'), h('div', { class: 'formula' }, T(equationTex(key), true)))
        : h('p', { id: 'not-in-census' }, 'This key is not in the census. A census key is the representative of an isomorphism class of elliptic K3 surfaces, so most integers are not keys.'));
    return;
  }
  const p2 = p2FromData(r.L, r.records);
  const split = splitP2(p2);
  const splitL = splitP2(r.L);
  let fibrePoly = [1];
  for (const e of fibreFactors(r.records)) {
    const g = new Array(e + 1).fill(0); g[0] = 1; g[e] = -(2 ** e);
    fibrePoly = polyMul(fibrePoly, g);
  }
  const splitB = splitP2(fibrePoly);
  const p2Tex = String.raw`\begin{aligned} P_2(u) &= ${brokenLines(polyTerms(p2))} \\ &= ${brokenLines(factorPieces(split))} \\ &= (1-2u)^{2} \Bigl(\prod_{v} B_v(u)\Bigr) L(E/K,u) \end{aligned}`;
  const partsTex = String.raw`\begin{aligned} \prod_{v} B_v(u) &= ${brokenLines(factorPieces(splitB))} \\ L(E/K,u) &= ${brokenLines(factorPieces(splitL))} \end{aligned}`;
  const code = magmaSnippet(r.key, p2);
  const codeElement = h('code', { class: 'language-magma' }, code);
  const fact = (label, value) => h('div', {}, h('dt', {}, labelNode(label)), h('dd', {}, value));

  view.replaceChildren(back,
    h('h1', { id: 'surface-title' }, `Surface ${r.key}`),
    h('h2', {}, 'Weierstrass model'),
    h('div', { class: 'formula', id: 'equation' }, T(equationTex(r.key), true)),
    h('p', { class: 'hint' }, labelNode('In \\(\\mathbf P(1,1,4,6)\\) over \\(\\mathbf F_2\\); the generic fibre \\(E\\) over \\(\\mathbf F_2(T)\\), \\(T = t/s\\), is obtained by setting \\(s = 1\\).')),

    h('h2', {}, 'Invariants'),
    h('dl', { class: 'facts', id: 'invariants' },
      fact('\\(a_1\\) class', T(a1Tex(r.a1))),
      fact('Torsion of \\(E(\\mathbf F_2(T))\\)', T(torsionTex(r.torsion))),
      fact('Rank of \\(E(\\mathbf F_2(T))\\)', r.analytic_rank),
      fact('Rank of \\(E(\\overline{\\mathbf F}_2(T))\\)', r.rank_geom),
      fact('\\(\\rho(X_{\\mathbf F_2})\\)', r.rho_f2),
      fact('\\(\\rho(X_{\\overline{\\mathbf F}_2})\\)', r.rho_geom),
      fact('Height', heightText(r.height)),
      fact('\\(\\#\\mathrm{Br}(X)\\cdot|\\mathrm{disc}\\,\\mathrm{NS}(X)|\\)', fmt(r.br_disc)),
      fact('Sign of \\(L\\)', r.L_sign > 0 ? '+1' : '−1'),
      fact('Sign of \\(P_2\\)', r.zeta_sign > 0 ? '+1' : '−1')),

    h('h2', {}, 'Singular fibres'),
    h('p', {}, T(configTex(r.config)), ` — ${r.n_singular} over the closure, at ${r.n_places} place${r.n_places === 1 ? '' : 's'} of `, T('\\mathbf F_2(T)'), '.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'fibre-table' },
      h('thead', {}, h('tr', {}, ['Type', '\\(\\deg P\\)', '\\(f_P\\)', '\\(c_P\\)', 'Components', 'Frobenius orbits'].map((t, i) => h('th', { class: i === 0 ? 'left' : null }, labelNode(t))))),
      h('tbody', {}, r.records.map(f => {
        const cyc = componentCycles(f.type, f.c);
        return h('tr', {}, h('td', { class: 'left' }, T(typeTex(f.type))), h('td', {}, String(f.deg)), h('td', {}, String(f.f)), h('td', {}, String(f.c)),
          h('td', {}, String(1 + cyc.reduce((a, b) => a + b, 0))), h('td', {}, cyc.length ? cyc.join(', ') : '–'));
      })))),
    h('p', { class: 'hint' }, labelNode('\\(f_P\\) is the conductor exponent and \\(c_P\\) the Tamagawa number. The last column lists the sizes of the Frobenius orbits on the components that do not meet the zero section, as computed by ComponentCycles.')),

    h('h2', {}, 'L-function'),
    h('div', { class: 'wrapping', id: 'l-function' }, T(`L(E/K,u) = ${polyTex(r.L)}`)),
    h('p', { class: 'hint' }, labelNode(`Here \\(K = \\mathbf F_2(T)\\) and \\(u = 2^{-s}\\); the degree is ${r.L_degree}.`)),

    h('h2', {}, 'Zeta function'),
    h('div', { class: 'formula' }, T('Z(X,u) = \\frac{1}{(1-u)\\,P_2(u)\\,(1-4u)}', true)),
    h('div', { class: 'formula', id: 'p2' }, T(p2Tex, true)),
    h('p', { class: 'hint' }, labelNode('The factor \\((1-2u)^2\\) comes from the zero section and a fibre.')),
    h('h3', {}, 'The contributions'),
    h('div', { class: 'formula', id: 'p2-parts' }, T(partsTex, true)),
    h('p', { class: 'hint' }, labelNode('Here \\(v\\) runs over the singular fibres, and \\(B_v(u) = \\det\\bigl(1 - (2u)^{\\deg v}\\,\\mathrm{Frob}_v\\bigr)\\) on the components of the fibre that do not meet the zero section.')),
    h('p', { class: 'hint' }, split.rest.length > 1
      ? labelNode(`Factors whose inverse roots have the form \\(2\\zeta\\), \\(\\zeta\\) a root of unity, come first; in \\(P_2\\) their degrees add up to \\(\\rho(X_{\\overline{\\mathbf F}_2})\\). The last factor, of degree ${split.rest.length - 1}, has no such inverse roots and is not necessarily irreducible.`)
      : labelNode('All inverse roots have the form \\(2\\zeta\\), \\(\\zeta\\) a root of unity, so the surface is supersingular.')),

    h('h2', {}, 'Points'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'points-table' },
      h('thead', {}, h('tr', {}, ['2', '4', '8', '16', '32'].map(q => h('th', {}, T(`\\#X(\\mathbf F_{${q}})`))))),
      h('tbody', {}, h('tr', {}, [r.pts_f2, r.pts_f4, r.pts_f8, r.pts_f16, r.pts_f32].map(v => h('td', {}, fmt(v))))))),

    h('h2', {}, 'Reproduce it in Magma'),
    h('div', { class: 'code-wrap' },
      h('button', { type: 'button', id: 'copy-magma', onclick: async (e) => {
        try { await navigator.clipboard.writeText(code); e.target.textContent = 'Copied'; }
        catch { e.target.textContent = 'Select the text to copy'; }
      } }, 'Copy'),
      h('pre', { id: 'magma' }, codeElement)),
    h('p', { class: 'hint' }, 'Paste this into Magma; it uses only built-in functions. The census code computes P2 from the L-function and the fibres, in functions_census.m in the ', h('a', { href: REPO }, 'census repository'), '.'));
  void highlightMagma(codeElement);
}

// ---------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------

function barChart(rows, { series = 1, labels = null, xTitle = '' }) {
  // A bar chart with a tooltip.
  //   Input:  rows, a list of [x, count] or [x, [count1, count2]]; series, 1 or 2;
  //           labels, the names of the two series; xTitle, a caption for the axis
  //   Output: an element holding the chart
  const W = 520, H = 210, m = { t: 8, r: 6, b: 38, l: 48 };
  const vals = rows.map(([, v]) => Array.isArray(v) ? v : [v, 0]);
  const top = Math.max(...vals.map(v => v[0] + v[1]), 1);
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(top)); for (const k of [1, 2, 4, 8, 10]) if (k * p >= top) return k * p; return top; })();
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const y = (v) => H - m.b - (v / nice) * (H - m.t - m.b);
  for (let i = 0; i <= 4; i++) {
    const v = nice * i / 4;
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(el('text', { class: 'tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, v >= 1e6 ? (v / 1e6) + 'M' : v >= 1000 ? (v / 1000) + 'k' : String(v)));
  }
  const step = (W - m.l - m.r) / rows.length, bw = Math.max(step * 0.82, 1);
  const every = Math.max(1, Math.ceil(Math.max(...rows.map(r => String(r[0]).length)) * 6.6 / step));
  const box = h('div', { class: 'chart-box' });
  const tip = h('div', { class: 'tip', hidden: true });
  rows.forEach(([x, raw], i) => {
    const [a, b] = vals[i], cx = m.l + i * step + (step - bw) / 2;
    if (a) svg.append(el('rect', { x: cx, y: y(a), width: bw, height: y(0) - y(a), fill: 'var(--series1)' }));
    if (b) svg.append(el('rect', { x: cx, y: y(a + b), width: bw, height: Math.max(y(a) - y(a + b) - (a ? 1 : 0), 0.5), fill: 'var(--series2)' }));
    if (i % every === 0) svg.append(el('text', { class: 'tick', x: cx + bw / 2, y: H - m.b + 14, 'text-anchor': 'middle' }, String(x).replace('inf', '∞')));
    const hit = el('rect', { x: m.l + i * step, y: m.t, width: step, height: H - m.t - m.b, fill: 'transparent', tabindex: 0 });
    const show = (ev) => {
      tip.textContent = series === 2 ? `${String(x).replace('inf', '∞')}: ${labels[0]} ${fmt(a)}, ${labels[1]} ${fmt(b)}` : `${String(x).replace('inf', '∞')}: ${fmt(a)} surfaces`;
      tip.hidden = false;
      const rect = box.getBoundingClientRect();
      const px = (ev.clientX ?? hit.getBoundingClientRect().left) - rect.left;
      tip.style.top = '0';
      tip.style.left = Math.max(0, Math.min(px + 10, rect.width - tip.offsetWidth)) + 'px';
    };
    hit.addEventListener('pointermove', show); hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; }); hit.addEventListener('blur', () => { tip.hidden = true; });
    svg.append(hit);
  });
  svg.append(el('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: 'var(--muted)', 'stroke-width': 1 }));
  svg.append(el('text', { class: 'tick', x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle' }, xTitle));
  box.append(svg, tip);
  return box;
}

async function renderStats() {
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const [s, m] = await Promise.all([fetchJson('data/stats.json'), getManifest()]);
  const card = (title, note, chart, legend) => h('article', { class: 'chart' }, h('h3', {}, labelNode(title)), h('p', {}, labelNode(note)),
    legend ? h('div', { class: 'legend' }, legend.map((l, i) => h('span', {}, h('i', { style: `background:var(--series${i + 1})` }), labelNode(l)))) : null, chart);
  const j0Names = ['a1 ≠ 0', 'a1 = 0'], ordNames = ['a1 = 0 or s²', 'a1 = st or s²+st+t²'];
  const binned = (rows, w) => rows.map(([x, v]) => [w === 1 ? x : `${x}`, v]);
  const brRows = s.br.map(([k, v]) => [k === 0 ? '1' : `2^${k}`, v]);

  view.replaceChildren(
    h('h1', {}, 'Statistics'),
    h('p', { class: 'prose', id: 'stats-warning' }, h('strong', {}, 'These charts describe incomplete data. '),
      `They cover ${fmt(m.rows)} of the ${fmt(m.models)} surfaces. Surfaces with `, T('a_1 = s^2+st+t^2'), ' are only ',
      `${Math.round(100 * m.rowsByA1['s^2 + s*t + t^2'] / m.expectedByA1['s^2 + s*t + t^2'])}% present, so the overall proportions will change when the census is complete. Counts are not weighted by automorphisms.`),

    h('h2', {}, 'Completeness'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'completeness' },
      h('thead', {}, h('tr', {}, ['\\(a_1\\)', 'In this release', 'In the census', 'Share'].map((t, i) => h('th', { class: i === 0 ? 'left' : null }, labelNode(t))))),
      h('tbody', {}, Object.keys(m.expectedByA1).map(a => h('tr', {}, h('td', { class: 'left' }, T(a1Tex(a))), h('td', {}, fmt(m.rowsByA1[a] || 0)), h('td', {}, fmt(m.expectedByA1[a])),
        h('td', {}, `${(100 * (m.rowsByA1[a] || 0) / m.expectedByA1[a]).toFixed(1)}%`)))))),

    h('h2', {}, 'Mordell–Weil and L-function'),
    h('div', { class: 'charts' },
      card('Rank of \\(E(\\overline{\\mathbf F}_2(T))\\)', String.raw`\(\rho(X_{\overline{\mathbf F}_2}) - 2 - \sum_v \deg v\,(m_v - 1)\), where \(m_v\) is the number of components of the fibre at \(v\) (Shioda–Tate).`, barChart(s.rank_geom, { xTitle: 'rank' })),
      card('Rank of \\(E(\\mathbf F_2(T))\\)', 'Computed as the order of vanishing of \\(L(E,s)\\) at \\(s=1\\), which equals the rank for these surfaces.', barChart(s.rank, { xTitle: 'rank' })),
      card('Torsion of \\(E(\\mathbf F_2(T))\\)', 'Subgroup of the Mordell–Weil group.', barChart([...s.torsion].sort((a, b) => byTorsionOrder(a[0], b[0])), { xTitle: 'torsion group' })),
      card('Degree of \\(L\\)', 'Equal to 20 minus the rank of the root lattices of the fibres.', barChart(s.L_degree, { xTitle: 'degree' })),
      card('Sign of \\(L\\)', 'In \\(L(E,u) = \\varepsilon\\,(2u)^n L(E,1/(4u))\\).', barChart(s.L_sign.map(([x, v]) => [Number(x) > 0 ? '+1' : '−1', v]), { xTitle: 'sign' })),
      card('Sign of \\(P_2\\)', 'In \\(P_2(u) = \\varepsilon_Z\\,(2u)^{22} P_2(1/(4u))\\).', barChart(s.zeta_sign.map(([x, v]) => [Number(x) > 0 ? '+1' : '−1', v]), { xTitle: 'sign' }))),

    h('h2', {}, 'Singular fibres'),
    h('div', { class: 'charts' },
      card('Singular fibres', 'Over \\(\\overline{\\mathbf F}_2\\).', barChart(s.singular, { series: 2, labels: j0Names, xTitle: 'number of singular fibres' }), ['\\(a_1 \\ne 0\\)', '\\(a_1 = 0\\)']),
      card('Reducible fibres', 'Over \\(\\overline{\\mathbf F}_2\\): every type except \\(\\mathrm{I}_1\\) and \\(\\mathrm{II}\\).', barChart(s.reducible, { series: 2, labels: j0Names, xTitle: 'number of reducible fibres' }), ['\\(a_1 \\ne 0\\)', '\\(a_1 = 0\\)']),
      card('Bad places', 'Places of \\(\\mathbf F_2(T)\\), counted once each.', barChart(s.n_places, { xTitle: 'number of bad places' }))),

    h('h2', {}, 'Picard numbers, height and Artin–Tate'),
    h('div', { class: 'charts' },
      card('\\(\\rho(X_{\\mathbf F_2})\\)', 'Picard number over \\(\\mathbf F_2\\).', barChart(s.rho_f2, { xTitle: 'Picard number' })),
      card('\\(\\rho(X_{\\overline{\\mathbf F}_2})\\)', 'Picard number over the closure.', barChart(s.rho_geom, { xTitle: 'geometric Picard number' })),
      card('Height of the formal Brauer group', '1 is ordinary and \\(\\infty\\) is supersingular.', barChart(s.height, { series: 2, labels: ordNames, xTitle: 'height' }), ['\\(a_1 = 0\\) or \\(s^2\\)', '\\(a_1 = st\\) or \\(s^2+st+t^2\\)']),
      card('\\(\\#\\mathrm{Br}(X)\\cdot|\\mathrm{disc}\\,\\mathrm{NS}(X)|\\)', 'Over \\(\\mathbf F_2\\), grouped by powers of 2: the bar \\(2^k\\) covers \\([2^k, 2^{k+1})\\).', barChart(brRows, { xTitle: 'lower end of the range' }))),

    h('h2', {}, 'Points'),
    h('div', { class: 'charts' }, ['2', '4', '8', '16', '32'].map(q => {
      const w = s.widths['pts_f' + q];
      return card(`\\(\\#X(\\mathbf F_{${q}})\\)`, w === 1 ? 'Number of points.' : `Number of points, in bins of ${w}.`, barChart(binned(s['pts_f' + q], w), { xTitle: w === 1 ? 'points' : 'start of the bin' }));
    })),

    h('h2', {}, 'Most common fibre configurations'),
    h('p', { class: 'hint' }, `${fmt(s.configurations.distinct)} configurations occur. The 30 most common:`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'top-configs' },
      h('thead', {}, h('tr', {}, h('th', { class: 'left' }, 'Configuration'), h('th', {}, 'Surfaces'))),
      h('tbody', {}, s.configurations.top.map(([c, n]) => h('tr', {}, h('td', { class: 'left' },
        h('a', { href: '#/search?config=' + encodeURIComponent(c) }, T(configTex(c)))), h('td', {}, fmt(n))))))),

    h('h2', {}, 'By class of a₁'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', id: 'by-a1' },
      h('thead', {}, h('tr', {}, ['\\(a_1\\)', 'Surfaces', 'Mean rank', 'Mean geometric rank', 'Mean singular', 'Max singular', 'Mean reducible', 'Max reducible', 'Mean \\(\\rho(X_{\\overline{\\mathbf F}_2})\\)', 'Supersingular', 'Ordinary', 'Non-trivial torsion'].map((t, i) => h('th', { class: i === 0 ? 'left' : null }, labelNode(t))))),
      h('tbody', {}, Object.keys(m.expectedByA1).filter(a => s.byA1[a]).map(a => { const v = s.byA1[a]; return h('tr', {},
        h('td', { class: 'left' }, T(a1Tex(a))), h('td', {}, fmt(v.models)), h('td', {}, (v.rank / v.models).toFixed(3)), h('td', {}, (v.rankGeom / v.models).toFixed(3)), h('td', {}, (v.singular / v.models).toFixed(2)), h('td', {}, v.maxSingular),
        h('td', {}, (v.reducible / v.models).toFixed(2)), h('td', {}, v.maxReducible), h('td', {}, (v.rho / v.models).toFixed(2)), h('td', {}, fmt(v.supersingular)), h('td', {}, fmt(v.ordinary)), h('td', {}, fmt(v.torsion))); })))));
}

// ---------------------------------------------------------------------------------------
// How it was made, and how to reference
// ---------------------------------------------------------------------------------------

async function renderMethod() {
  const m = await getManifest();
  const para = (text) => h('p', {}, labelNode(text));
  view.replaceChildren(h('div', { class: 'prose' },
    h('h1', {}, 'How the census was made'),
    para('Each surface has a Weierstrass model \\(y^2 + a_1xy + a_3y = x^3 + a_2x^2 + a_4x + a_6\\) in \\(\\mathbf P(1,1,4,6)\\), where \\(a_i\\) is a binary form of degree \\(2i\\) in \\(s,t\\) over \\(\\mathbf F_2\\). Models are identified under \\(\\mathrm{GL}_2(\\mathbf F_2)\\) acting on \\((s,t)\\) and the changes \\(x \\mapsto x+q\\), \\(y \\mapsto y+px+r\\). A model with \\(\\Delta \\ne 0\\) that is minimal at every place is an elliptic K3 surface with a section.'),
    para('In characteristic 2 the change \\(x \\mapsto x + a_2\\) removes \\(a_2\\), which leaves 32 coefficient bits. The enumeration then follows the staged quotient and stabilizer method of Auel, Kulkarni, Petok and Weinbaum:'),
    h('p', {}, h('a', { href: 'https://arxiv.org/abs/2306.09908' }, 'A census of cubic fourfolds over F2, arXiv:2306.09908'), '. It finds the orbits of pairs ', T('(a_1,a_3)'), ', then the orbits of the affine action of each stabilizer on the remaining coordinates.'),
    para(`This gives ${fmt(m.models)} surfaces. The key of a surface is the 32 bits of its canonical representative: \\(a_1\\), \\(a_3\\), \\(a_4\\), \\(a_6\\), most significant first, each from \\(s^d\\) down to \\(t^d\\).`),
    h('h2', {}, 'What is computed'),
    para('For each surface, with generic fibre \\(E\\) over \\(\\mathbf F_2(T)\\), Magma computes the local data by Tate’s algorithm (LocalInformation), the L-function (LFunction) and the torsion (TorsionSubgroup). The rest follows from those:'),
    h('ul', {},
      h('li', {}, labelNode('\\(P_2(u) = (1-2u)^2 \\prod_v F_v(u)\\,L(E,u)\\), where \\(F_v\\) comes from the Frobenius action on the fibre components.')),
      h('li', {}, labelNode('The Picard numbers, read off from the inverse roots of \\(P_2\\) using the Tate conjecture.')),
      h('li', {}, labelNode('The height, from the 2-adic Newton polygon of \\(P_2\\), and \\(\\#\\mathrm{Br}(X)\\cdot|\\mathrm{disc}\\,\\mathrm{NS}(X)|\\), from the Artin–Tate formula.')),
      h('li', {}, labelNode('The point counts \\(\\#X(\\mathbf F_{2^r})\\), from the zeta function.'))),
    h('h2', {}, 'Checks'),
    h('ul', {},
      h('li', {}, labelNode('The orbit counts agree with an independent Burnside count over all \\(2^{37}\\) models.')),
      h('li', {}, 'The minimality filter agrees with Magma’s Tate algorithm on all census representatives with a high discriminant valuation at a candidate place, and on 20,000 random others.'),
      h('li', {}, labelNode('Every row of this release has Euler number 24 by Ogg’s formula, and its stored \\(P_2\\) agrees with the one recomputed from \\(L\\) and the fibres when the site’s data is built. The Picard numbers were re-derived on a 2% sample.'))),
    para('Not yet done: a comparison with an outside count, and the automorphism groups needed for a mass formula check.'),
    h('h2', {}, 'Status of this release'),
    h('p', { id: 'release-status' }, `${fmt(m.rows)} of ${fmt(m.models)} surfaces are present. Quasi-elliptic surfaces are not included yet. Data file: ${m.source}, built ${m.built} from census commit ${m.censusCommit}.`),
    h('h2', {}, 'Code'),
    h('p', {}, h('a', { href: REPO }, 'The census repository'), ' has the enumeration (elliptic_fibration_orbits_f2.m), the minimality test (k3_minimality_f2.m), the invariants (functions_census.m) and the driver (run_census.m). Each surface’s page has a Magma snippet that reproduces it.')));
}

async function renderCite() {
  const m = await getManifest();
  const cite = `Elise Alvarez-Salazar, Edgar Costa, Håvard Damm-Johnsen and Alvaro Gonzalez-Hernandez, Census of elliptic and quasielliptic K3 surfaces over F2, preview, ${m.built.slice(0, 4)}. ${location.origin}${location.pathname}`;
  view.replaceChildren(h('div', { class: 'prose' },
    h('h1', {}, 'How to reference'),
    h('p', { id: 'cite-warning' }, h('strong', {}, 'Please don’t cite this preview yet. '), 'The data is incomplete and may change. A release with a Zenodo DOI, and a paper, will follow.'),
    h('h2', {}, 'Draft citation'),
    h('pre', { id: 'citation', style: 'white-space:pre-wrap' }, cite),
    h('h2', {}, 'Referring to a surface'),
    h('p', {}, 'Each surface has a permanent key. Refer to it by key, together with the release, and link to its page. The key decodes to the equation with FibrationFromKeyF2 in the census code.'),
    h('h2', {}, 'Code and data'),
    h('p', {}, h('a', { href: REPO }, 'Census repository on GitHub'), '. Data file of this release: ', m.source, '.')));
}

// ---------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, qs] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const section = parts[0] || 'search';
  document.querySelectorAll('nav a').forEach(a => {
    if (a.dataset.nav === section || (section === 'surface' && a.dataset.nav === 'search')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  try {
    if (section === 'search') await renderSearch(parseHashParams(qs));
    else if (section === 'surface') await renderSurface(parts[1] || '');
    else if (section === 'stats') await renderStats();
    else if (section === 'method') await renderMethod();
    else if (section === 'cite') await renderCite();
    else view.replaceChildren(h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '#/search' }, 'Go to search')));
  } catch (err) {
    window.__censusLastError = String(err);
    view.replaceChildren(h('p', { class: 'error', role: 'alert' }, 'This page could not load: ' + (err.message || err)));
  }
  window.scrollTo(0, 0);
}

async function start() {
  const m = await getManifest().catch(() => null);
  if (m && m.missing) document.getElementById('banner').textContent = `Preview: incomplete data, do not cite. ${fmt(m.rows)} of ${fmt(m.models)} surfaces are present.`;
  document.getElementById('site-name').innerHTML = 'Census of elliptic and quasielliptic K3 surfaces over ' + tex('\\mathbf{F}_2');
  window.addEventListener('hashchange', route);
  route();
}
if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
