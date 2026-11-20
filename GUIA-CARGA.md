# Cómo cargar los resultados en three r160 (import map, sin bundler)

## Qué vendorizar de `three@0.160.0`

Lista confirmada leyendo los `import` de cada loader en r160:

| Archivo (bajo `examples/jsm/`) | Lo necesita |
|---|---|
| `loaders/GLTFLoader.js` | todo glb |
| `loaders/DRACOLoader.js` | glb con Draco (solo importa `three`) |
| `libs/draco/gltf/draco_decoder.js`, `draco_wasm_wrapper.js`, `draco_decoder.wasm` | DRACOLoader (los carga en un worker) |
| `libs/meshopt_decoder.module.js` | glb con Meshopt (sin imports) |
| `loaders/KTX2Loader.js` | KTX2 suelto o en glb |
| `utils/WorkerPool.js` | KTX2Loader (no estaba en el plan original) |
| `libs/ktx-parse.module.js`, `libs/zstddec.module.js` | KTX2Loader |
| `libs/basis/basis_transcoder.js`, `basis_transcoder.wasm` | KTX2Loader (worker) |

## Código con el import map típico (`"three/addons/": "./vendor/three/examples/jsm/"`)

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const draco = new DRACOLoader().setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
const ktx2 = new KTX2Loader().setTranscoderPath('./vendor/three/examples/jsm/libs/basis/').detectSupport(renderer);
const gltf = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

const { scene: modelo } = await gltf.loadAsync('./assets/modelo.glb');
// al terminar de cargar todo:
draco.dispose(); ktx2.dispose();
```

## Variante por CDN

Mismas rutas bajo `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/…`
(por ejemplo `setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/')`).

## Texturas sueltas

- **WebP:** `TextureLoader` (o `createImageBitmap`) lo carga igual que un JPG; solo cambia la extensión. Mismo `colorSpace`, `flipY` y `wrap` que tenías.
- **KTX2:**
  ```js
  ktx2.load('./assets/tex/pasto_a.ktx2', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;   // solo albedo; normales/rugosidad se quedan en lineal
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    material.map = t; material.needsUpdate = true;
  });
  ```
  - Las texturas comprimidas no admiten `flipY`: oriéntalas en origen (UV con `flipY = false`, como los glb).
  - Los mipmaps deben venir en el archivo (`comprimir.mjs` los genera con `--genmipmap`); three no los genera para formatos comprimidos.

## Servidor

Meshopt solo rinde de verdad si el servidor manda **gzip o brotli** (ver columna gzip del reporte). Un `http.server`
de Python no comprime; nginx/Caddy sí, si se configura para `model/gltf-binary`.

## Cuándo usar cada cosa

| Opción | Úsala cuando | Ojo |
|---|---|---|
| **Meshopt** (por defecto) | casi siempre: decodifica muy rápido, sin worker ni wasm extra | gana poco sin gzip/brotli en el servidor |
| **Draco** | la descarga manda (red lenta, sin compresión HTTP) y la geometría es densa | decodifica más lento, necesita worker + wasm |
| **WebP** | bajar MB de descarga de fotos/PNG | **no baja VRAM**; JPG ya comprimidos a veces crecen (se marcan SIN-GANANCIA) |
| **KTX2** (ETC1S color, UASTC normales) | escenas con muchas texturas 1024²+ donde la VRAM o el tiempo de subida a la GPU duelen | requiere `toktx`, transcoder basis y cambiar el código de carga |
