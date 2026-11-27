// png-squeeze-01: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Pipeline (all deterministic; every choice is a function of the input bytes only):
//   1. Decode the stored input PNG to RGBA.
//   2. Screen colour forms the way a scale compressor does: palette (<=256 colours,
//      transparent entries first), grey / grey+alpha, RGB / RGBA, plus a tRNS key when
//      a single fully-transparent value exists and no opaque pixel shares it.
//   3. Screen filters per form (fixed 0/1/2/4, minimum-sum, fewest-pairs, and brute
//      force per row only when the filtered data is small enough for it to be cheap),
//      weighing each candidate by its zlib level-6 size plus PLTE/tRNS chunk bytes.
//   4. Re-compress the winner with an optimal-parsing DEFLATE (hash-chain longest
//      match search with structural distances, backward dynamic programming, iterative
//      Huffman cost re-estimation, fixed-vs-dynamic block choice), sized to the data:
//      small inputs get the full search, big ones a cheaper one. The optimal stream is
//      kept only when it beats zlib level 9 on the same data.
//   5. Write the PNG with only IHDR / PLTE / tRNS / IDAT / IEND chunks, bit depth 8,
//      non-interlaced.
//
// Node 22, erasable-syntax TypeScript only; Node built-ins only; no network, no clock.
import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;

// ---------------------------------------------------------------- PNG codec

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilterRow(type: number, src: Uint8Array, srcOff: number, prev: Uint8Array | null, bpp: number, out: Uint8Array, outOff: number, stride: number): void {
  if (type === 0) {
    out.set(src.subarray(srcOff, srcOff + stride), outOff);
  } else if (type === 1) {
    for (let i = 0; i < stride; i++) out[outOff + i] = src[srcOff + i] + (i >= bpp ? out[outOff + i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < stride; i++) out[outOff + i] = src[srcOff + i] + (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[outOff + i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      out[outOff + i] = src[srcOff + i] + ((left + up) >> 1);
    }
  } else {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[outOff + i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[outOff + i] = src[srcOff + i] + paeth(a, b, c);
    }
  }
}

// Decode any contest-legal PNG (bit depth 8, non-interlaced, types 0/2/3/4/6) to RGBA.
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`bad CRC on ${type}`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error(`unexpected chunk ${type}`);
    }
  }
  const bpp = CHANS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('inflated size mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    unfilterRow(ft, raw, y * (stride + 1) + 1, prev, bpp, samples, y * stride, stride);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = (palette as Uint8Array)[e * 3];
      lut[e * 4 + 1] = (palette as Uint8Array)[e * 3 + 1];
      lut[e * 4 + 2] = (palette as Uint8Array)[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------- Filters

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filter `samples` (height rows of width*bpp) by `choice`: a fixed type, or
// 'minsum' / 'pairs' / 'brute' per-row heuristics. Returns the filtered bytes.
function filterImage(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[t][0] = t;
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') {
        cost = signedSum(trial[t].subarray(1));
      } else if (choice === 'pairs') {
        stamp++;
        let np = 0;
        const row = trial[t].subarray(1);
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seen[pair] !== stamp) { seen[pair] = stamp; np++; }
        }
        cost = np;
      } else {
        cost = deflateSync(trial[t], before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- Forms

type Colour = { rgba: number[]; word: number; count: number };

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const u32 = new Uint32Array(aligned.buffer, aligned.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, colours };
}

// The single fully-transparent value usable as a tRNS key, or null.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

type Form = {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: (number | string)[];
};

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): Form {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const u32 = new Uint32Array(aligned.buffer, aligned.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return {
    colourType: 3, bpp: 1, samples: indices, plte, trns,
    filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
  };
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY };

// Screen all forms / filter choices by zlib level-6 size (+ PLTE/tRNS chunk
// bytes). Brute force per row is tried for every form: it is the choice that
// most often wins on screenshot rows, and its per-row zlib runs are small
// (one row plus a 32 KiB dictionary), so its cost stays modest next to the
// optimal-parsing deflate that follows.
function screen(rgba: Uint8Array, width: number, height: number): { form: Form; data: Uint8Array } {
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    for (const choice of form.filters) {
      const data = filterImage(form.samples, width, height, form.bpp, choice);
      const bytes = deflateSync(data, SCREEN_OPTS).length + chunks;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  return { form: (best as { form: Form }).form, data: (best as { data: Uint8Array }).data };
}

// ---------------------------------------------------------------- DEFLATE
// Optimal-parsing DEFLATE in the manner of zopfli, written from scratch:
// hash-chain longest-match search (plus structural distances that dominate
// filtered PNG data), backward dynamic-programming parse, iterative Huffman
// cost re-estimation, fixed-vs-dynamic single-block choice.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function lenSymbol(len: number): number {
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1;
  }
  return 257 + lo;
}
function distSymbol(d: number): number {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}
const LEN_SYM_BY_LEN: Uint16Array = (() => {
  const t = new Uint16Array(259);
  for (let len = 3; len <= 258; len++) t[len] = lenSymbol(len);
  return t;
})();

// --- Huffman lengths, length-limited by flooring rare frequencies. --------
function huffmanLengths(freq: Float64Array | Uint32Array, syms: number[]): Uint8Array {
  const lengths = new Uint8Array(freq.length);
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  const heap: number[] = [];
  const hFreq: number[] = [];
  const hLeft: number[] = [];
  const hRight: number[] = [];
  const hSym: number[] = [];
  const push = (node: number): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hFreq[heap[p]] <= hFreq[heap[i]]) break;
      const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && hFreq[heap[l]] < hFreq[heap[m]]) m = l;
        if (r < heap.length && hFreq[heap[r]] < hFreq[heap[m]]) m = r;
        if (m === i) break;
        const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp;
        i = m;
      }
    }
    return top;
  };
  for (const s of syms) {
    const node = hFreq.length;
    hFreq.push(freq[s]); hLeft.push(-1); hRight.push(-1); hSym.push(s);
    push(node);
  }
  while (heap.length < 2) {
    const node = hFreq.length;
    hFreq.push(1); hLeft.push(-1); hRight.push(-1); hSym.push(-1);
    push(node);
  }
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    const node = hFreq.length;
    hFreq.push(hFreq[a] + hFreq[b]); hLeft.push(a); hRight.push(b); hSym.push(-1);
    push(node);
  }
  const root = heap[0];
  const stack: [number, number][] = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop() as [number, number];
    if (hSym[node] >= 0) lengths[hSym[node]] = depth;
    else { stack.push([hLeft[node], depth + 1]); stack.push([hRight[node], depth + 1]); }
  }
  return lengths;
}

function buildLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  let maxFreq = 0;
  for (const s of syms) if (freq[s] > maxFreq) maxFreq = freq[s];
  const floors: number[] = [1];
  for (let f = 2; f <= maxFreq; f *= 2) floors.push(f);
  if (floors[floors.length - 1] !== maxFreq) floors.push(maxFreq);
  let best: { lengths: Uint8Array; cost: number } | null = null;
  for (const f of floors) {
    const f2 = new Float64Array(n);
    for (const s of syms) f2[s] = Math.max(freq[s], f);
    const lens = huffmanLengths(f2, syms);
    let mx = 0;
    for (const s of syms) if (lens[s] > mx) mx = lens[s];
    if (mx > maxBits) continue;
    let cost = 0;
    for (const s of syms) cost += freq[s] * lens[s];
    if (best === null || cost < best.cost) best = { lengths: lens, cost };
  }
  if (best === null) throw new Error('no length-limited Huffman code');
  return best.lengths;
}

function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const n = lengths.length;
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l === 0) continue;
    let c = nextCode[l]++;
    let r = 0;
    for (let b = 0; b < l; b++) { r = (r << 1) | (c & 1); c >>>= 1; }
    codes[i] = r;
  }
  return codes;
}

// --- Bit writer over a growing buffer. ------------------------------------
class BitWriter {
  buf: Uint8Array;
  at: number;
  acc: number;
  nbits: number;
  constructor(cap: number) {
    this.buf = new Uint8Array(Math.max(1024, cap));
    this.at = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  ensure(extra: number): void {
    if (this.at + extra + 8 > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.at + extra + 1024));
      nb.set(this.buf.subarray(0, this.at));
      this.buf = nb;
    }
  }
  write(code: number, len: number): void {
    this.acc |= code << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.ensure(1);
      this.buf[this.at++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  finish(): Uint8Array {
    if (this.nbits > 0) {
      this.ensure(1);
      this.buf[this.at++] = this.acc & 0xff;
      this.acc = 0;
      this.nbits = 0;
    }
    return this.buf.subarray(0, this.at);
  }
}

// --- Match finding: structural distances + short hash chain. --------------
function findMatches(data: Uint8Array, maxChain: number, niceLen: number, stride: number): { mlen: Uint16Array; mdist: Uint32Array } {
  const n = data.length;
  const mlen = new Uint16Array(n);
  const mdist = new Uint32Array(n);
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const struct = stride > 0
    ? [1, 2, 3, stride - 1, stride, stride + 1].filter((d, k, a) => d >= 1 && a.indexOf(d) === k)
    : [1, 2, 3];
  for (let i = 0; i + 2 < n; i++) {
    const h = (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) * 0x9e3779b1 >>> 17) & (HASH_SIZE - 1);
    prev[i] = head[h];
    head[h] = i;
    const maxLen = Math.min(258, n - i);
    if (maxLen < 3) break;
    let bestLen = 0;
    let bestDist = 0;
    for (let s = 0; s < struct.length; s++) {
      const d = struct[s];
      if (d > i) continue;
      const p = i - d;
      if (data[p] !== data[i] || data[p + 1] !== data[i + 1] || data[p + 2] !== data[i + 2]) continue;
      if (bestLen > 0 && bestLen < maxLen && data[p + bestLen] !== data[i + bestLen]) continue;
      let len = 3;
      while (len < maxLen && data[p + len] === data[i + len]) len++;
      if (len > bestLen || (len === bestLen && len > 0 && d < bestDist)) { bestLen = len; bestDist = d; }
      if (len >= niceLen) break;
    }
    if (!(bestLen >= niceLen && bestDist <= 3)) {
      let p = prev[i];
      let chain = 0;
      const limit = Math.max(0, i - 32768);
      const budget = bestLen >= niceLen ? 4 : maxChain;
      while (p >= limit && chain < budget) {
        chain++;
        const d = i - p;
        if (bestLen >= niceLen) {
          if (d >= bestDist) { p = prev[p]; continue; }
          let len = 0;
          while (len < maxLen && data[p + len] === data[i + len]) len++;
          if (len >= bestLen) { bestLen = len; bestDist = d; }
        } else {
          if (bestLen > 0 && (bestLen >= maxLen || data[p + bestLen] !== data[i + bestLen])) { p = prev[p]; continue; }
          let len = 0;
          while (len < maxLen && data[p + len] === data[i + len]) len++;
          if (len > bestLen || (len === bestLen && len > 0 && d < bestDist)) {
            bestLen = len; bestDist = d;
            if (len >= maxLen) break;
          }
        }
        p = prev[p];
      }
    }
    if (bestLen >= 3) { mlen[i] = bestLen; mdist[i] = bestDist; }
  }
  return { mlen, mdist };
}

// --- Optimal parse: backward DP. `allLengths` tries every length 3..ml;
// otherwise only the longest length of each length-symbol range (fast). -----
function optimalParse(data: Uint8Array, mlen: Uint16Array, mdist: Uint32Array, litCost: Int32Array, lenCost: Int32Array, distCost: Int32Array, allLengths: boolean): { choiceLen: Uint16Array; choiceDist: Uint32Array } {
  const n = data.length;
  const costs = new Int32Array(n + 1);
  const choiceLen = new Uint16Array(n);
  const choiceDist = new Uint32Array(n);
  costs[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let best = litCost[data[i]] + costs[i + 1];
    let bl = 0;
    let bd = 0;
    const ml = mlen[i];
    if (ml >= 3) {
      const d = mdist[i];
      const dc = distCost[distSymbol(d)];
      if (allLengths) {
        for (let l = 3; l <= ml; l++) {
          const c = lenCost[LEN_SYM_BY_LEN[l]] + dc + costs[i + l];
          if (c < best) { best = c; bl = l; bd = d; }
        }
      } else {
        let l = 3;
        while (l <= ml) {
          const sym = LEN_SYM_BY_LEN[l];
          let end = LEN_BASE[sym - 257] + (1 << LEN_EXTRA[sym - 257]) - 1;
          if (end > ml) end = ml;
          const c = lenCost[sym] + dc + costs[i + end];
          if (c < best) { best = c; bl = end; bd = d; }
          l = end + 1;
        }
      }
    }
    costs[i] = best;
    choiceLen[i] = bl;
    choiceDist[i] = bd;
  }
  return { choiceLen, choiceDist };
}

type Seq = { litFreq: Uint32Array; distFreq: Uint32Array; lits: number[]; lens: number[]; dists: number[]; isMatch: number[] };

function emitSequence(data: Uint8Array, choiceLen: Uint16Array, choiceDist: Uint32Array): Seq {
  const n = data.length;
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(32);
  const lits: number[] = [];
  const lens: number[] = [];
  const dists: number[] = [];
  const isMatch: number[] = [];
  let i = 0;
  while (i < n) {
    const l = choiceLen[i];
    if (l === 0) {
      lits.push(data[i]); isMatch.push(0);
      litFreq[data[i]]++;
      i++;
    } else {
      const sym = lenSymbol(l);
      lits.push(sym); lens.push(l); dists.push(choiceDist[i]); isMatch.push(1);
      litFreq[sym]++;
      distFreq[distSymbol(choiceDist[i])]++;
      i += l;
    }
  }
  lits.push(256); isMatch.push(0);
  litFreq[256]++;
  return { litFreq, distFreq, lits, lens, dists, isMatch };
}

const FIXED_LIT_LEN: Uint8Array = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

function lenCostsFromLit(litLen: Uint8Array): Int32Array {
  const c = new Int32Array(288);
  for (let s = 257; s < 286; s++) c[s] = litLen[s] + LEN_EXTRA[s - 257];
  return c;
}
function distCostsFromDist(distLen: Uint8Array): Int32Array {
  const c = new Int32Array(32);
  for (let s = 0; s < 30; s++) c[s] = distLen[s] + DIST_EXTRA[s];
  return c;
}

function emitBody(bw: BitWriter, seq: Seq, litLen: Uint8Array, distLen: Uint8Array, dynamic: boolean): void {
  if (!dynamic) {
    const litCodes = canonicalCodes(FIXED_LIT_LEN);
    const distCodes = canonicalCodes(FIXED_DIST_LEN);
    bw.write(1, 1);
    bw.write(1, 2);
    let mi = 0;
    for (let k = 0; k < seq.lits.length; k++) {
      if (seq.isMatch[k] === 0) {
        const s = seq.lits[k];
        bw.write(litCodes[s], FIXED_LIT_LEN[s]);
      } else {
        const sym = seq.lits[k];
        bw.write(litCodes[sym], FIXED_LIT_LEN[sym]);
        const l = seq.lens[mi];
        const d = seq.dists[mi];
        const li = sym - 257;
        if (LEN_EXTRA[li] > 0) bw.write(l - LEN_BASE[li], LEN_EXTRA[li]);
        const ds = distSymbol(d);
        bw.write(distCodes[ds], 5);
        if (DIST_EXTRA[ds] > 0) bw.write(d - DIST_BASE[ds], DIST_EXTRA[ds]);
        mi++;
      }
    }
    return;
  }
  let nLit = 0;
  let nDist = 0;
  for (let i = 0; i < litLen.length; i++) if (litLen[i] > 0) nLit++;
  for (let i = 0; i < distLen.length; i++) if (distLen[i] > 0) nDist++;
  if (nDist === 0) { distLen[0] = 1; nDist = 1; }
  if (nLit === 1) { litLen[0] = 1; nLit = 2; }
  let hlit = 29;
  while (hlit > 0 && litLen[256 + hlit] === 0) hlit--;
  let hdist = 29;
  while (hdist > 0 && distLen[hdist] === 0) hdist--;
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  const all: number[] = [];
  for (let i = 0; i <= 256 + hlit; i++) all.push(litLen[i]);
  for (let i = 0; i <= hdist; i++) all.push(distLen[i]);
  const clSyms: number[] = [];
  const clExtra: ([number, number] | null)[] = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    if (v === 0) {
      let run = 0;
      while (i + run < all.length && all[i + run] === 0) run++;
      i += run;
      while (run >= 11) { const take = Math.min(run, 138); clSyms.push(18); clExtra.push([take - 11, 7]); run -= take; }
      if (run >= 3) { clSyms.push(17); clExtra.push([run - 3, 3]); run = 0; }
      while (run > 0) { clSyms.push(0); clExtra.push(null); run--; }
    } else {
      clSyms.push(v); clExtra.push(null);
      let run = 0;
      while (i + 1 + run < all.length && all[i + 1 + run] === v) run++;
      i += 1 + run;
      let r = run;
      while (r >= 3) { const take = Math.min(r, 6); clSyms.push(16); clExtra.push([take - 3, 2]); r -= take; }
      while (r > 0) { clSyms.push(v); clExtra.push(null); r--; }
    }
  }
  const clFreq = new Uint32Array(19);
  for (const s of clSyms) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLen);
  bw.write(1, 1);
  bw.write(2, 2);
  bw.write(hlit, 5);
  bw.write(hdist, 5);
  bw.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.write(clLen[CL_ORDER[k]], 3);
  for (let k = 0; k < clSyms.length; k++) {
    const s = clSyms[k];
    bw.write(clCodes[s], clLen[s]);
    const ex = clExtra[k];
    if (ex) bw.write(ex[0], ex[1]);
  }
  let mi = 0;
  for (let k = 0; k < seq.lits.length; k++) {
    if (seq.isMatch[k] === 0) {
      const s = seq.lits[k];
      bw.write(litCodes[s], litLen[s]);
    } else {
      const sym = seq.lits[k];
      bw.write(litCodes[sym], litLen[sym]);
      const l = seq.lens[mi];
      const d = seq.dists[mi];
      const li = sym - 257;
      if (LEN_EXTRA[li] > 0) bw.write(l - LEN_BASE[li], LEN_EXTRA[li]);
      const ds = distSymbol(d);
      bw.write(distCodes[ds], distLen[ds]);
      if (DIST_EXTRA[ds] > 0) bw.write(d - DIST_BASE[ds], DIST_EXTRA[ds]);
      mi++;
    }
  }
}

// Optimal-parsing DEFLATE of `data` as one zlib stream. Settings scale with
// the data size only: small inputs get the full search, big ones a cheaper one.
function deflateOptimal(data: Uint8Array, stride: number): Uint8Array {
  const n = data.length;
  const tiny = n < 300000;
  const small = n < 1500000;
  const maxChain = tiny ? 256 : small ? 128 : 64;
  const iterations = tiny ? 3 : 2;
  const allLengths = !small ? false : true;
  const { mlen, mdist } = findMatches(data, maxChain, 258, stride);
  const litCost = new Int32Array(288);
  for (let i = 0; i < 288; i++) litCost[i] = FIXED_LIT_LEN[i];
  let lenCost = lenCostsFromLit(FIXED_LIT_LEN);
  const distCost = new Int32Array(32);
  for (let s = 0; s < 30; s++) distCost[s] = 5 + DIST_EXTRA[s];
  let seq: Seq | null = null;
  for (let it = 0; it < iterations; it++) {
    const parse = optimalParse(data, mlen, mdist, litCost, lenCost, distCost, allLengths);
    seq = emitSequence(data, parse.choiceLen, parse.choiceDist);
    if (it === iterations - 1) break;
    const litLen = buildLengths(seq.litFreq, 15);
    const distLen = buildLengths(seq.distFreq, 15);
    for (let i = 0; i < 288; i++) litCost[i] = litLen[i];
    lenCost = lenCostsFromLit(litLen);
    const dc = distCostsFromDist(distLen);
    for (let s = 0; s < 32; s++) distCost[s] = dc[s];
  }
  const s = seq as Seq;
  const litLen = buildLengths(s.litFreq, 15);
  const distLen = buildLengths(s.distFreq, 15);
  const cap = Math.max(1024, (data.length / 8) | 0);
  const bwFixed = new BitWriter(cap);
  emitBody(bwFixed, s, litLen, distLen, false);
  const fixedBytes = bwFixed.finish();
  const bwDyn = new BitWriter(cap);
  emitBody(bwDyn, s, litLen, distLen, true);
  const dynBytes = bwDyn.finish();
  const best = dynBytes.length <= fixedBytes.length ? dynBytes : fixedBytes;
  const out = new Uint8Array(2 + best.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(best, 2);
  const ad = adler32(data);
  out[2 + best.length] = (ad >>> 24) & 0xff;
  out[3 + best.length] = (ad >>> 16) & 0xff;
  out[4 + best.length] = (ad >>> 8) & 0xff;
  out[5 + best.length] = ad & 0xff;
  return out;
}

// ---------------------------------------------------------------- Driver

function squeezeOne(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const { form, data } = screen(rgba, width, height);
  const stride = 1 + width * form.bpp;
  const optimal = deflateOptimal(data, stride);
  // Safety net: never ship worse than zlib level 9 on the same filtered data.
  const z9 = deflateSync(data, { level: 9, memLevel: 9 });
  const idat = optimal.length <= z9.length ? optimal : new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const ids = readdirSync(inputDir).sort();
  for (const id of ids) {
    const bytes = new Uint8Array(readFileSync(join(inputDir, id, 'image.png')));
    const { width, height, rgba } = decodePng(bytes);
    const out = squeezeOne(rgba, width, height);
    mkdirSync(join(outputDir, id), { recursive: true });
    writeFileSync(join(outputDir, id, 'image.png'), out);
  }
}

main();
