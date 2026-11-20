# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [0.1.0] - 2026-11-20

### Añadido
- `comprimir.mjs`: auditoría de jpg/png (bytes, dimensiones, banderas, VRAM estimada) y conversión a WebP con sharp.
- Pipeline glb/gltf sobre glTF-Transform 4: `dedup`, `prune`, `weld`, Meshopt (por defecto) o Draco, texturas embebidas a WebP, validación con glTF-Validator y tamaño con gzip.
- KTX2 para texturas sueltas vía `toktx` (opcional; error claro si no está).
- Modo dry-run (por defecto sin `--salida`), regla `SIN-GANANCIA` y reporte `--json`.
- `prueba.mjs`, `GUIA-CARGA.md` y ejemplo de auditoría en `ejemplos/`.
