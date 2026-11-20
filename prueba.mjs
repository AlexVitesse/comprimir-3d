// Prueba de comprimir-3d: todo en un mkdtemp, sin frameworks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'comprimir.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'comprimir-3d-prueba-'));
const IN = path.join(T, 'in');
fs.mkdirSync(IN);
const correr = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const leerJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const fila = (rep, nombre) => rep.archivos.find((x) => x.archivo === nombre);
const huella = (dir) => fs.readdirSync(dir).sort().map((f) => f + ':' + createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex')).join('\n');
// ruido suavizado: comprimible pero no trivial
const ruido = (lado) => {
  const px = Buffer.alloc(lado * lado * 3);
  for (let i = 0; i < px.length; i++) px[i] = Math.random() * 256;
  return sharp(px, { raw: { width: lado, height: lado, channels: 3 } }).blur(1.5);
};

try {
  // ---------- material de prueba ----------
  const N = 200;
  const pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), idx = new Uint32Array((N - 1) * (N - 1) * 6);
  for (let y = 0, k = 0; y < N; y++) for (let x = 0; x < N; x++, k++) {
    pos.set([x / (N - 1) - 0.5, 0, y / (N - 1) - 0.5], k * 3); nor.set([0, 1, 0], k * 3); uv.set([x / (N - 1), y / (N - 1)], k * 2);
  }
  for (let y = 0, k = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) {
    const a = y * N + x, b = a + 1, c = a + N, d = c + 1;
    idx.set([a, c, b, b, c, d], k); k += 6;
  }
  const TRIS = idx.length / 3;
  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (t, a) => doc.createAccessor().setType(t).setArray(a).setBuffer(buf);
  const tex = doc.createTexture('ruido').setMimeType('image/png').setImage(await ruido(1024).png().toBuffer());
  const prim = doc.createPrimitive().setAttribute('POSITION', acc('VEC3', pos)).setAttribute('NORMAL', acc('VEC3', nor))
    .setAttribute('TEXCOORD_0', acc('VEC2', uv)).setIndices(acc('SCALAR', idx))
    .setMaterial(doc.createMaterial('m').setBaseColorTexture(tex));
  doc.createScene().addChild(doc.createNode('rejilla').setMesh(doc.createMesh('rejilla').addPrimitive(prim)));
  await new NodeIO().write(path.join(IN, 'modelo.glb'), doc);
  await ruido(2048).png().toFile(path.join(IN, 'suelta.png'));
  await ruido(512).jpeg({ quality: 95 }).toFile(path.join(IN, 'x_n.jpg'));
  const antes = huella(IN);
  const peso = (f) => fs.statSync(path.join(IN, f)).size;

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder,
  });
  await MeshoptDecoder.ready;
  const tris = (d) => d.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((s, p) => s + p.getIndices().getCount() / 3, 0);

  // ---------- --dry-run ----------
  let r = correr(IN, '--dry-run', '--salida', path.join(T, 'out-dry'), '--json', path.join(T, 'dry.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /^MODO: dry-run \(no se escribe nada\)$/);
  assert.equal(huella(IN), antes, 'la entrada cambió en dry-run');
  assert.ok(!fs.existsSync(path.join(T, 'out-dry')), 'dry-run creó la salida');
  let rep = leerJSON(path.join(T, 'dry.json'));
  assert.ok(fila(rep, 'suelta.png').banderas.includes('GRANDE'));
  assert.ok(fila(rep, 'suelta.png').banderas.includes('PNG-SIN-ALFA'));
  console.log('ok  dry-run: entrada intacta, sin salida, GRANDE + PNG-SIN-ALFA');

  // ---------- --geometria meshopt ----------
  const OUT = path.join(T, 'out');
  r = correr(IN, '--salida', OUT, '--geometria', 'meshopt', '--json', path.join(T, 'meshopt.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], `MODO: escribe en ${OUT}`);
  assert.equal(huella(IN), antes, 'la entrada cambió');
  rep = leerJSON(path.join(T, 'meshopt.json'));
  assert.ok(fs.statSync(path.join(OUT, 'modelo.glb')).size < peso('modelo.glb'), 'el glb meshopt no pesa menos');
  let d = await io.read(path.join(OUT, 'modelo.glb'));
  assert.equal(tris(d), TRIS, 'cambió el número de triángulos');
  assert.ok(d.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'EXT_meshopt_compression'));
  assert.deepEqual(d.getRoot().listTextures().map((t) => t.getMimeType()), ['image/webp']);
  assert.equal(fila(rep, 'modelo.glb').validador.errores, 0, 'gltf-validator reporta errores');
  for (const [orig, webp] of [['suelta.png', 'suelta.webp'], ['x_n.jpg', 'x_n.webp']]) {
    assert.ok(fs.statSync(path.join(OUT, webp)).size < peso(orig), `${webp} no pesa menos`);
  }
  assert.equal(fila(rep, 'x_n.jpg').calidad, 92, 'x_n no usó la calidad de normales');
  assert.equal(fila(rep, 'suelta.png').calidad, 80);
  console.log('ok  meshopt: glb menor, mismos tris, textura webp, validador sin errores; sueltas menores; x_n con calidad 92');

  // ---------- --geometria draco ----------
  const OUT2 = path.join(T, 'out-draco');
  r = correr(IN, '--salida', OUT2, '--geometria', 'draco', '--texturas', 'no');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(path.join(OUT2, 'modelo.glb')).size < peso('modelo.glb'));
  d = await io.read(path.join(OUT2, 'modelo.glb'));
  assert.equal(tris(d), TRIS);
  assert.ok(d.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'KHR_draco_mesh_compression'));
  console.log('ok  draco: glb menor, mismos tris, declara KHR_draco_mesh_compression');

  // ---------- errores esperados ----------
  r = correr(IN, '--salida', IN);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /no puede ser la carpeta de entrada/);
  const hayToktx = !spawnSync('toktx', ['--version']).error;
  if (!hayToktx) {
    r = correr(IN, '--dry-run', '--texturas', 'ktx2');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /toktx.*KTX-Software/s);
  }
  assert.equal(huella(IN), antes);
  console.log(`ok  errores: --salida = entrada${hayToktx ? '' : ', --texturas ktx2 sin toktx'}`);
  console.log('\nTODO OK');
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
