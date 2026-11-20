# comprimir-3d

Audita y comprime los assets de un gemelo 3D en three.js: **glb/gltf** (Meshopt o Draco + texturas WebP) y **texturas sueltas** (WebP o KTX2).
Es una envoltura delgada: el trabajo lo hacen [glTF-Transform](https://github.com/donmccurdy/glTF-Transform) 4.x
(`dedup`, `prune`, `weld`, `reorder`, `meshopt`, `draco`, `textureCompress`), [sharp](https://sharp.pixelplumbing.com/),
`toktx` de [KTX-Software](https://github.com/KhronosGroup/KTX-Software) y [glTF-Validator](https://github.com/KhronosGroup/glTF-Validator).

## Instalación

```
npm i          # node_modules pesa ~39 MB (la mayor parte es libvips de sharp)
npm test       # node prueba.mjs
```

Node ≥ 20. No necesita `@gltf-transform/cli`. KTX2 es opcional y solo si `toktx` está en el PATH.

## Uso

```
node comprimir.mjs <carpeta|archivo> [--salida <dir>] [--dry-run] [--geometria meshopt|draco|no]
     [--texturas webp|ktx2|no] [--calidad 80] [--calidad-normales 92] [--max 2048] [--umbral 300]
     [--excluir dev,media,vendor] [--json reporte.json]
```

- **Nunca escribe en la entrada.** Sin `--salida`, o con `--dry-run`, solo reporta (los números son los reales: se comprime en memoria y se descarta). `--salida` igual a la carpeta de entrada es un error.
- Si un archivo comprimido pesa más que el original se marca `SIN-GANANCIA` y no se escribe.
- Un `.gltf` sale como `.glb`; sus `.bin` e imágenes externas cuentan en "antes" y no se tratan como sueltas.
- Se excluyen `node_modules`, `.git`, carpetas ocultas, la propia salida y lo de `--excluir` (nombre o ruta relativa).
- La primera línea dice `MODO: dry-run (no se escribe nada)` o `MODO: escribe en <dir>`; después va una tabla markdown y los totales. `--json` guarda todo el detalle.

### Banderas de la auditoría (jpg/png)

| Bandera | Significado |
|---|---|
| `GRANDE` | más de `--umbral` KB |
| `>MAX` | lado mayor que `--max` (se reduce al convertir) |
| `NPOT` / `NO-MULT-4` | no potencia de 2 / no múltiplo de 4 (KTX2 y mipmaps lo agradecen) |
| `PNG-SIN-ALFA` | PNG sin canal alfa: debería ser JPG/WebP |
| `YA-OPTIMIZADA` | webp o ktx2, no se toca |
| `SIN-GANANCIA` | el resultado pesaba más; se conserva el original |
| `VALIDADOR-ERRORES:n` | glb de salida con errores de glTF-Validator |

VRAM: se estima RGBA8 con mipmaps (`w·h·4·1.33`) contra KTX2 (`w·h·1·1.33`). **WebP no baja VRAM** (se decodifica a RGBA8), solo descarga.

### Clasificación de texturas (por nombre)

`_n.` o `normal` → normal (usa `--calidad-normales` y `smartSubsample`; en KTX2, UASTC lineal).
`_r.`, `rough`, `metal`, `ao` → lineal (KTX2 UASTC). El resto es color sRGB (KTX2 ETC1S). En glb, las normales se detectan por slot (`normalTexture`).

### KTX2

- Sueltas: `--texturas ktx2`. Si `toktx --version` no responde, sale con error y el enlace de KTX-Software; nunca cae a otro formato.
  Flags usadas: color `--t2 --encode etc1s --genmipmap --assign_oetf srgb`; normales/lineales `--t2 --encode uastc --uastc_quality 2 --zcmp 19 --genmipmap --assign_oetf linear`.
  **No probadas en esta máquina** (no hay `toktx`): confírmalas con `toktx --help` de tu versión.
- Dentro de glb: fuera de alcance. Usa `npx @gltf-transform/cli etc1s in.glb out.glb` (o `uastc`).

Cómo cargarlo todo en three r160: [GUIA-CARGA.md](GUIA-CARGA.md).

## Ejemplo: auditoría dry-run de un gemelo de ejemplo

Reporte completo en [ejemplos/auditoria-gemelo.md](ejemplos/auditoria-gemelo.md) (`--dry-run --excluir dev,investigacion,media,presentacion,vendor`).
El gemelo genera su geometría por código, así que hay **0 glb** y 26 imágenes:

| Grupo | Archivos | Antes | Después (WebP) | VRAM RGBA8 → KTX2 |
|---|---:|---:|---:|---:|
| Biblioteca de texturas PBR (`assets/tex/`, JPG 512²–1024²) | 22 | 3.70 MB | 3.51 MB (−5 %; 10 mejoran, 12 `SIN-GANANCIA`) | 85 MB → 21 MB |
| Imágenes de UI (2 PNG 1600×900 sin alfa) | 2 | 2.04 MB | 0.22 MB (−89 %) | — |
| **Total** | 26 | 5.77 MB | 3.75 MB (−35 %) | 100 MB → 25 MB |

Conclusiones: los JPG de la biblioteca ya vienen bien comprimidos y WebP casi no los mejora; la ganancia de descarga está en los 2 PNG sin alfa
y la ganancia grande está en **VRAM** (unos 64 MB menos) si se pasa la biblioteca a KTX2. `GRANDE` salió en `pasto_n`, `palma_n`, `asfalto_n` y en los 2 PNG.

## Pruebas

`node prueba.mjs` crea en un `mkdtemp` un glb sintético (rejilla 200×200 con textura PNG 1024² de ruido), un PNG 2048² sin alfa y un `x_n.jpg`, y comprueba:
dry-run sin cambios ni salida, banderas, meshopt y draco (menor peso, mismos triángulos, extensión declarada, textura `image/webp`, validador sin errores),
calidad de normales y los errores esperados (`--salida` = entrada, `ktx2` sin `toktx`).

## Alternativas

- `npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp`: lo mismo para un solo glb.
- [gltfpack](https://github.com/zeux/meshoptimizer) (meshoptimizer): un binario que cuantiza, simplifica y comprime con meshopt; muy rápido.

## Desviaciones respecto al plan

- La biblioteca del gemelo de ejemplo tiene 22 JPG (3.7 MB), no 24; en total salen 26 imágenes (una ya es webp), no 27.
- El plan suponía ahorro con WebP; en JPG ya comprimidos WebP q80 suele **crecer**. La regla `SIN-GANANCIA` los deja como están.
- El dry-run no usa `mkdtemp`: comprime en memoria (`writeBinary` / `toBuffer`) y descarta; los números son igual de reales. `mkdtemp` solo se usa como scratch de `toktx`.
- KTX2Loader de r160 también importa `utils/WorkerPool.js` (faltaba en la lista a vendorizar).
- glTF-Transform escribe su log en stdout; se baja a `WARN` para que la primera línea sea siempre `MODO:`.
- En glb, `textureCompress` corre dos veces (slot `normalTexture` con `--calidad-normales`, resto con `--calidad`).
- Se incluyó `gltf-validator` (≈0.4 MB) para validar cada glb de salida.
- `node_modules` pesa ~39 MB, menos que los 60–80 MB estimados.
- `--salida` dentro de la entrada está permitida (se excluye del recorrido); solo se rechaza que sea la misma carpeta.

## Fuera de alcance v0.1

KTX2 dentro de glb, simplificación de mallas, sobrescribir en su lugar y detectar texturas sin uso (en los gemelos los nombres se arman en código; grep no sirve).

## Licencia

MIT © 2026 AlexVitesse
