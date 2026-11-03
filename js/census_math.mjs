// census_math.mjs
//
// The small amount of mathematics shared by the data build (build_site_data.mjs) and the website,
// which gets a copy of this file: keys, singular fibres, and the factors of P2.
// Polynomials are arrays of coefficients, constant term first.  Every coefficient of L and P2
// is far below 2^53, so ordinary numbers are exact.

export function decodeKey(key) {
  // The model of an orbit key, as FibrationFromKeyF2 reads it.
  //   Input:  key, an integer in [0, 2^32)
  //   Output: { a1, a3, a4, a6 }, each a list of [s exponent, t exponent] of its monomials
  const form = (n, d) => {
    const out = [];
    for (let i = 0; i <= d; i++) if (Math.floor(n / 2 ** (d - i)) % 2) out.push([d - i, i]);
    return out;
  };
  return { a1: form(Math.floor(key / 2 ** 29), 2), a3: form(Math.floor(key / 2 ** 22) % 128, 6),
           a4: form(Math.floor(key / 2 ** 13) % 512, 8), a6: form(key % 8192, 12) };
}

export function parseFibres(text) {
  // The singular_fibres column as records.
  //   Input:  text, "deg:f:c:type;deg:f:c:type;..."
  //   Output: a list of { deg, f, c, type } with deg, f, c integers
  return text.split(';').map(r => { const [deg, f, c, type] = r.split(':');
    return { deg: Number(deg), f: Number(f), c: Number(c), type }; });
}

export function componentCycles(type, c) {
  // Frobenius orbit sizes on the non-identity components of a fibre; ComponentCycles in
  // functions_census.m.
  //   Input:  type, the Kodaira symbol ("I4", "IV*", "I0*"); c, the Tamagawa number
  //   Output: a list of positive integers adding up to (number of components - 1)
  const ones = (k) => Array(k).fill(1);
  if (type === 'II') return [];
  if (type === 'III') return [1];
  if (type === 'IV') return c === 3 ? [1, 1] : [2];
  if (type === 'IV*') return c === 3 ? ones(6) : [1, 1, 2, 2];
  if (type === 'III*') return ones(7);
  if (type === 'II*') return ones(8);
  if (type.endsWith('*')) {
    const n = Number(type.slice(1, -1));
    if (n === 0) {
      if (c === 4) return ones(4);
      if (c === 2) return [1, 1, 2];
      if (c === 1) return [1, 3];
    } else {
      if (c === 4) return ones(n + 4);
      if (c === 2) return [...ones(n + 2), 2];
    }
  } else {
    const n = Number(type.slice(1));
    if (n <= 1) return [];
    if (c === n) return ones(n - 1);
    if (n % 2 === 1 && c === 1) return Array((n - 1) / 2).fill(2);
    if (n % 2 === 0 && c === 2) return [1, ...Array((n - 2) / 2).fill(2)];
  }
  throw new Error(`unexpected Tamagawa number ${c} for Kodaira type ${type}`);
}

export function typeOrder(type) {
  // A sort position for Kodaira types: I_n, then I_n*, then II, III, IV, IV*, III*, II*.
  //   Input:  type, the Kodaira symbol
  //   Output: a number
  const named = { 'II': 2000, 'III': 2001, 'IV': 2002, 'IV*': 2003, 'III*': 2004, 'II*': 2005 };
  if (type in named) return named[type];
  return type.endsWith('*') ? 1000 + Number(type.slice(1, -1)) : Number(type.slice(1));
}

export function configuration(records) {
  // The fibre configuration over the algebraic closure, in a canonical form.
  //   Input:  records, from parseFibres
  //   Output: a string such as "16 I1, I4, IV"
  const n = new Map();
  for (const r of records) n.set(r.type, (n.get(r.type) || 0) + r.deg);
  return [...n].sort((a, b) => typeOrder(a[0]) - typeOrder(b[0]))
    .map(([t, k]) => (k > 1 ? `${k} ${t}` : t)).join(', ');
}

export function normaliseConfiguration(text) {
  // A configuration typed by a person, in the canonical form.
  //   Input:  text, such as "iv, 16 I1,I4" or "16I1 I4 IV"
  //   Output: the canonical string, or null if it isn't a valid configuration
  const parts = text.toUpperCase().match(/(\d+\s*)?(IV\*|III\*|II\*|IV|III|II|I\d+\*?)/g);
  if (!parts || parts.join('').replace(/\s/g, '') !== text.toUpperCase().replace(/[\s,;]/g, '')) return null;
  const n = new Map();
  for (const p of parts) {
    const m = p.match(/^(\d+)?\s*(.+)$/);
    n.set(m[2], (n.get(m[2]) || 0) + (m[1] ? Number(m[1]) : 1));
  }
  return [...n].sort((a, b) => typeOrder(a[0]) - typeOrder(b[0]))
    .map(([t, k]) => (k > 1 ? `${k} ${t}` : t)).join(', ');
}

export const isReducible = (type) => type !== 'I1' && type !== 'II';

export function polyMul(a, b) {
  // The product of two polynomials.
  //   Input:  a, b, coefficient lists, constant term first
  //   Output: their product, as a coefficient list
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => { if (x) b.forEach((y, j) => { out[i + j] += x * y; }); });
  return out;
}

export function fibreFactors(records) {
  // The factors 1 - (2u)^(k deg P) of P2 from the fibres, one per Frobenius orbit of components.
  //   Input:  records, from parseFibres
  //   Output: a list of exponents e = k * deg P, each meaning the factor 1 - (2u)^e
  const out = [];
  for (const r of records) for (const k of componentCycles(r.type, r.c)) out.push(k * r.deg);
  return out.sort((a, b) => a - b);
}

export function p2FromData(L, records) {
  // P2 from the L-function and the fibres; P2FromData in functions_census.m, with q = 2.
  //   Input:  L, a coefficient list; records, from parseFibres
  //   Output: P2, a coefficient list
  let p = polyMul([1, -4, 4], L);
  for (const e of fibreFactors(records)) {
    const f = new Array(e + 1).fill(0); f[0] = 1; f[e] = -(2 ** e);
    p = polyMul(p, f);
  }
  return p;
}

function divideExact(p, d) {
  // p / d when d divides p in Z[u] and d has constant term 1; otherwise null.
  if (p.length < d.length) return null;
  const q = new Array(p.length - d.length + 1).fill(0), r = p.slice();
  for (let i = 0; i < q.length; i++) {
    q[i] = r[i];
    if (q[i]) for (let j = 0; j < d.length; j++) r[i + j] -= q[i] * d[j];
  }
  return r.every(x => x === 0) ? q : null;
}

const cyclotomicScaled = (() => {
  // psi[n](u) = prod over primitive n-th roots z of (1 - 2 z u), for n up to 200.
  const phi = [null], out = [];
  const N = 200;
  for (let n = 1; n <= N; n++) {
    let p = new Array(n + 1).fill(0); p[0] = 1; p[n] = -1;     // 1 - u^n = prod_{d|n} rev(Phi_d)
    for (let d = 1; d < n; d++) if (n % d === 0) p = divideExact(p, phi[d]);
    phi[n] = p;
    if (p.length - 1 <= 22) out.push({ n, poly: p.map((c, i) => c * 2 ** i) });
  }
  return out;
})();

export function splitP2(p) {
  // Splits a polynomial into the factors whose inverse roots are 2 * (root of unity) and the rest.
  //   Input:  p, a coefficient list with constant term 1 (P2 or L)
  //   Output: { algebraic: [{ n, mult, poly }], rest }, where n is the order of the root of unity
  //           and rest is the remaining factor, not necessarily irreducible
  let rest = p.slice();
  const algebraic = [];
  for (const { n, poly } of cyclotomicScaled) {
    let mult = 0;
    for (;;) {
      const q = divideExact(rest, poly);
      if (!q) break;
      rest = q; mult++;
    }
    if (mult) algebraic.push({ n, mult, poly });
  }
  return { algebraic, rest };
}

export function rowFromCsv(cols) {
  // One surface as an object with the column names of the site's search table.
  //   Input:  cols, the fields of a row of the site's row files
  //   Output: an object; height is null for a supersingular surface
  const [key, a1, torsion, fibres, L, L_sign, rank, zeta_sign, rho_f2, rho_geom, height, br_disc,
         pts_f2, pts_f4, pts_f8, pts_f16, pts_f32] = cols;
  const records = parseFibres(fibres);
  const lc = L.split(' ').map(Number);
  return {
    key: Number(key), a1, torsion, fibres, L: lc, records,
    config: configuration(records),
    n_places: records.length,
    n_singular: records.reduce((s, r) => s + r.deg, 0),
    n_reducible: records.reduce((s, r) => s + (isReducible(r.type) ? r.deg : 0), 0),
    L_degree: lc.length - 1,
    L_sign: Number(L_sign), analytic_rank: Number(rank), zeta_sign: Number(zeta_sign),
    rho_f2: Number(rho_f2), rho_geom: Number(rho_geom),
    height: height === 'inf' ? null : Number(height), br_disc: Number(br_disc),
    pts_f2: Number(pts_f2), pts_f4: Number(pts_f4), pts_f8: Number(pts_f8),
    pts_f16: Number(pts_f16), pts_f32: Number(pts_f32),
  };
}
