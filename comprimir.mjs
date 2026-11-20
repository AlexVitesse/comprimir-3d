#!/usr/bin/env node
// comprimir-3d: auditoría y compresión de glb/gltf y texturas sueltas.
// Envoltura delgada: glTF-Transform (dedup/prune/weld/meshopt/draco/textureCompress), sharp (WebP), toktx (KTX2), gltf-validator.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// ponytail: heurística por nombre; pasar a un manifiesto si falla.
const RE_NORMAL = /_n\.|normal/i;
const RE_LINEAL = /_n\.|_r\.|normal|rough|metal|\bao\b/i;
const EXT_GLB = new Set(['.glb', '.gltf']);
const EXT_TEX = new Set(['.jpg', '.jpeg', '.png']);
const EXT_YA = new Set(['.webp', '.ktx2']);
const URL_KTX = 'https://github.com/KhronosGroup/KTX-Software/releases';

const fallar = (msg) => { console.error(`comprimir-3d: ${msg}`); process.exit(2); };

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    salida: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    geometria: { type: 'string', default: 'meshopt' },
    texturas: { type: 'string', default: 'webp' },
    calidad: { type: 'string', default: '80' },
    'calidad-normales': { type: 'string', default: '92' },
    max: { type: 'string', default: '2048' },
    umbral: { type: 'string', default: '300' },
    excluir: { type: 'string', default: '' },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (o.help || positionals.length !== 1) {
  console.log(`uso: node comprimir.mjs <carpeta|archivo> [--salida <dir>] [--dry-run] [--geometria meshopt|draco|no]
     [--texturas webp|ktx2|no] [--calidad 80] [--calidad-normales 92] [--max 2048] [--umbral 300]
     [--excluir dev,media,vendor] [--json reporte.json]`);
  process.exit(o.help ? 0 : 2);
}
if (!['meshopt', 'draco', 'no'].includes(o.geometria)) fallar(`--geometria inválida: ${o.geometria}`);
if (!['webp', 'ktx2', 'no'].includes(o.texturas)) fallar(`--texturas inválida: ${o.texturas}`);
const num = (k) => { const n = Number(o[k]); if (!Number.isFinite(n) || n <= 0) fallar(`--${k} debe ser un número > 0`); return n; };
const CAL = num('calidad'), CAL_N = num('calidad-normales'), MAX = num('max'), UMBRAL = num('umbral') * 1024;

const entrada = path.resolve(positionals[0]);
if (!fs.existsSync(entrada)) fallar(`no existe la entrada: ${entrada}`);
const esDir = fs.statSync(entrada).isDirectory();
const base = esDir ? entrada : path.dirname(entrada);
const dry = o['dry-run'] || !o.salida;
const salida = o.salida ? path.resolve(o.salida) : null;
if (salida && !dry && path.relative(salida, base) === '') fallar(`--salida no puede ser la carpeta de entrada (${base}); nunca se escribe en la entrada`);

if (o.texturas === 'ktx2') {
  const r = spawnSync('toktx', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) fallar(`--texturas ktx2 requiere 'toktx' en el PATH y no responde. Instala KTX-Software: ${URL_KTX}`);
}

// ---------- recorrido ----------
const excluir = new Set(o.excluir.split(',').map((s) => s.trim()).filter(Boolean));
function* recorrer(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const rel = path.relative(base, p).split(path.sep).join('/');
      if (e.name === 'node_modules' || e.name.startsWith('.') || excluir.has(e.name) || excluir.has(rel)) continue;
      if (salida && path.relative(salida, p) === '') continue;
      yield* recorrer(p);
    } else if (e.isFile()) yield p;
  }
}
const archivos = esDir ? [...recorrer(base)] : [entrada];

// Recursos externos de cada .gltf: van dentro del glb y no se tratan como sueltos.
const recursosGltf = new Map();
for (const f of archivos) {
  if (path.extname(f).toLowerCase() !== '.gltf') continue;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const uris = [...(j.buffers || []), ...(j.images || [])].map((x) => x.uri).filter((u) => u && !u.startsWith('data:'));
  recursosGltf.set(f, uris.map((u) => path.resolve(path.dirname(f), decodeURIComponent(u))));
}
const usados = new Set([...recursosGltf.values()].flat());

// ---------- utilidades ----------
const gz = (buf) => gzipSync(buf).length;
const vram = (w, h, bpp) => Math.round(w * h * bpp * 1.33);
const ajustar = (w, h) => { const k = Math.min(1, MAX / Math.max(w, h)); return [Math.round(w * k), Math.round(h * k)]; };
const relDe = (f) => path.relative(base, f).split(path.sep).join('/');
function escribir(rel, buf) {
  const p = path.join(salida, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
}
let tmp = null; // solo para toktx, que trabaja con archivos
const dirTmp = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'comprimir-3d-')));

function banderasTextura(bytes, m, ext) {
  const b = [];
  if (bytes > UMBRAL) b.push('GRANDE');
  if (Math.max(m.width, m.height) > MAX) b.push('>MAX');
  const pot = (n) => (n & (n - 1)) === 0;
  if (!pot(m.width) || !pot(m.height)) b.push('NPOT');
  if (m.width % 4 || m.height % 4) b.push('NO-MULT-4');
  if (ext === '.png' && !m.hasAlpha) b.push('PNG-SIN-ALFA');
  return b;
}

async function textura(f, ext, orig) {
  const m = await sharp(f).metadata();
  const normal = RE_NORMAL.test(path.basename(f)), lineal = RE_LINEAL.test(path.basename(f));
  const [w2, h2] = ajustar(m.width, m.height);
  const r = {
    tipo: normal ? 'textura-normal' : lineal ? 'textura-lineal' : 'textura-color',
    dims: [m.width, m.height], banderas: banderasTextura(orig.length, m, ext),
    vram: { rgba8: vram(m.width, m.height, 4), ktx2: vram(w2, h2, 1) },
  };
  if (o.texturas === 'no') return r;
  const redim = (s) => s.resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true });
  let buf, ext2;
  if (o.texturas === 'webp') {
    r.calidad = normal ? CAL_N : CAL;
    ({ data: buf } = await redim(sharp(f)).webp({ quality: r.calidad, smartSubsample: normal }).toBuffer({ resolveWithObject: true }));
    ext2 = '.webp';
  } else {
    // ponytail: flags de toktx 4.x sin probar aquí (toktx no estaba instalado); confirmar con `toktx --help`.
    const png = path.join(dirTmp(), 'in.png'), out = path.join(dirTmp(), 'out.ktx2');
    await redim(sharp(f)).png().toFile(png);
    const args = lineal
      ? ['--t2', '--encode', 'uastc', '--uastc_quality', '2', '--zcmp', '19', '--genmipmap', '--assign_oetf', 'linear']
      : ['--t2', '--encode', 'etc1s', '--genmipmap', '--assign_oetf', 'srgb'];
    const t = spawnSync('toktx', [...args, out, png], { encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`toktx falló: ${t.stderr || t.error}`);
    buf = fs.readFileSync(out);
    r.codec = lineal ? 'uastc' : 'etc1s';
    ext2 = '.ktx2';
  }
  r.dimsDespues = [w2, h2];
  r.despues = buf.length;
  r.gzipDespues = gz(buf);
  r.salida = relDe(f).replace(/\.[^.]+$/, ext2);
  if (buf.length >= orig.length) { r.banderas.push('SIN-GANANCIA'); r.salida = null; }
  else if (!dry) escribir(r.salida, buf);
  return r;
}

// ---------- glb ----------
let io = null;
async function nodeIO() {
  if (io) return io;
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const draco3d = (await import('draco3dgltf')).default;
  const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  return io;
}
function contarMalla(doc) {
  let tris = 0, verts = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const n = p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0;
    verts += p.getAttribute('POSITION')?.getCount() ?? 0;
    if (p.getMode() === 4) tris += n / 3; else if (p.getMode() === 5 || p.getMode() === 6) tris += Math.max(0, n - 2);
  }
  return { tris, verts };
}

async function glb(f, ext, orig) {
  const F = await import('@gltf-transform/functions');
  const { MeshoptEncoder } = await import('meshoptimizer');
  const io = await nodeIO();
  const { Logger } = await import('@gltf-transform/core');
  const doc = (await io.read(f)).setLogger(new Logger(Logger.Verbosity.WARN));
  const r = { tipo: ext.slice(1), banderas: [], antesMalla: contarMalla(doc) };
  const pasos = [F.dedup(), F.prune(), F.weld()];
  if (o.geometria === 'meshopt') pasos.push(F.reorder({ encoder: MeshoptEncoder }), F.meshopt({ encoder: MeshoptEncoder }));
  if (o.geometria === 'draco') pasos.push(F.draco());
  if (o.texturas === 'webp') {
    const tc = { encoder: sharp, targetFormat: 'webp', resize: [MAX, MAX] };
    pasos.push(F.textureCompress({ ...tc, quality: CAL_N, slots: /^normalTexture$/ }), F.textureCompress({ ...tc, quality: CAL, slots: /^(?!normalTexture$)/ }));
  } else if (o.texturas === 'ktx2') r.banderas.push('KTX2-EN-GLB-NO (usa gltf-transform etc1s/uastc)');
  await doc.transform(...pasos);
  r.despuesMalla = contarMalla(doc);
  r.texturas = doc.getRoot().listTextures().map((t) => t.getMimeType());
  const buf = Buffer.from(await io.writeBinary(doc));
  try {
    const { validateBytes } = (await import('gltf-validator')).default;
    const v = await validateBytes(new Uint8Array(buf));
    r.validador = { errores: v.issues.numErrors, avisos: v.issues.numWarnings };
    if (v.issues.numErrors) r.banderas.push(`VALIDADOR-ERRORES:${v.issues.numErrors}`);
  } catch (e) { r.validador = { fallo: e.message }; }
  r.despues = buf.length;
  r.gzipDespues = gz(buf);
  r.salida = relDe(f).replace(/\.gltf$/i, '.glb');
  if (buf.length >= orig.length) { r.banderas.push('SIN-GANANCIA'); r.salida = null; }
  else if (!dry) escribir(r.salida, buf);
  return r;
}

// ---------- principal ----------
console.log(dry ? 'MODO: dry-run (no se escribe nada)' : `MODO: escribe en ${salida}`);
const filas = [];
for (const f of archivos) {
  const ext = path.extname(f).toLowerCase();
  if (usados.has(f) || !(EXT_GLB.has(ext) || EXT_TEX.has(ext) || EXT_YA.has(ext))) continue;
  // Para .gltf, "antes" incluye sus .bin e imágenes externas.
  const orig = ext === '.gltf' ? Buffer.concat([f, ...recursosGltf.get(f)].map((p) => fs.readFileSync(p))) : fs.readFileSync(f);
  const fila = { archivo: relDe(f), antes: orig.length, gzipAntes: gz(orig) };
  try {
    if (EXT_YA.has(ext)) {
      const m = ext === '.webp' ? await sharp(f).metadata() : null;
      Object.assign(fila, { tipo: 'textura', banderas: ['YA-OPTIMIZADA'], dims: m ? [m.width, m.height] : null });
    } else Object.assign(fila, await (EXT_GLB.has(ext) ? glb(f, ext, orig) : textura(f, ext, orig)));
  } catch (e) {
    Object.assign(fila, { tipo: fila.tipo || ext.slice(1), banderas: [`ERROR: ${e.message}`] });
    process.exitCode = 1;
  }
  filas.push(fila);
}
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });

// ---------- reporte ----------
const kb = (n) => (n == null ? '—' : `${(n / 1024).toFixed(1)} KB`);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const pct = (a, b) => (b == null ? '—' : `${(((b - a) / a) * 100).toFixed(0)}%`);
const efectivo = (x) => (x.salida ? x.despues : x.antes); // sin ganancia = se queda el original
const tot = filas.reduce((t, x) => ({
  antes: t.antes + x.antes, despues: t.despues + efectivo(x),
  vram: t.vram + (x.vram?.rgba8 ?? 0), vram2: t.vram2 + (x.vram?.ktx2 ?? 0),
}), { antes: 0, despues: 0, vram: 0, vram2: 0 });
const nGlb = filas.filter((x) => x.tipo === 'glb' || x.tipo === 'gltf').length;

console.log(`\nEntrada: ${esDir ? path.basename(base) + '/' : path.basename(entrada)} · geometría=${o.geometria} · texturas=${o.texturas} · calidad=${CAL}/${CAL_N} (normales) · max=${MAX}\n`);
console.log('| archivo | tipo | antes | después | Δ% | gzip antes/después | dimensiones | banderas | VRAM RGBA8 → KTX2 |');
console.log('|---|---|---:|---:|---:|---:|---|---|---:|');
for (const x of filas) {
  const dims = x.dims ? `${x.dims.join('×')}${x.dimsDespues && x.dimsDespues[0] !== x.dims[0] ? ` → ${x.dimsDespues.join('×')}` : ''}`
    : x.antesMalla ? `${x.antesMalla.tris} tris, ${x.antesMalla.verts}→${x.despuesMalla.verts} verts` : '—';
  const v = x.vram ? `${mb(x.vram.rgba8)} → ${mb(x.vram.ktx2)}` : '—';
  console.log(`| ${x.archivo} | ${x.tipo} | ${kb(x.antes)} | ${kb(x.despues)} | ${pct(x.antes, x.despues)} | ${kb(x.gzipAntes)} / ${kb(x.gzipDespues)} | ${dims} | ${x.banderas.join(' ')} | ${v} |`);
}
console.log(`| **TOTAL (${filas.length} archivos, ${nGlb} glb)** | | **${kb(tot.antes)}** | **${kb(tot.despues)}** | **${pct(tot.antes, tot.despues)}** | | | | **${mb(tot.vram)} → ${mb(tot.vram2)}** |`);
console.log('\n"después" del total cuenta el original donde no hubo ganancia. VRAM: WebP no baja VRAM (salvo por --max); KTX2 sí.');

if (o.json) {
  const rep = { version: 1, fecha: new Date().toISOString(), modo: dry ? 'dry-run' : 'escribe', entrada: path.basename(entrada), opciones: { ...o, json: undefined, salida: undefined }, archivos: filas, totales: { antes: tot.antes, despues: tot.despues, vramRGBA8: tot.vram, vramKTX2: tot.vram2 } };
  fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
  fs.writeFileSync(o.json, JSON.stringify(rep, null, 2));
}
