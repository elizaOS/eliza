# doctr.cpp — ggml port of doCTR

C++ port of [Mindee doCTR](https://github.com/mindee/doctr) built directly on
[ggml](https://github.com/ggml-org/ggml). Two stages:

- **Detection** — `db_mobilenet_v3_large` backbone + DBNet head → probability map.
- **Recognition** — `crnn_mobilenet_v3_small` backbone + BiLSTM + CTC head → per-crop logits.

The post-processing (DBNet contour → bbox, CTC greedy decode) stays in
TypeScript — both are trivial and runtime-portable. This C++ library runs only
the forward pass; the JS caller orchestrates det → crop → rec → decode.

## Status

**Phase 1 (current):** FFI surface scaffolded; weight conversion script
authored; build glue authored. **GGUF weight files are not yet built.** The TS
binding throws a clear error until `vision/doctr-det.gguf` and
`vision/doctr-rec.gguf` are present on disk.

## Build (when implemented)

```bash
cd plugins/plugin-vision/native/doctr.cpp
cmake -B build -S . -DGGML_METAL=ON   # macOS arm64
cmake --build build --config Release
```

Produces a single shared library `libdoctr.dylib` / `.so` / `.dll` consumed
via `bun:ffi` from `plugin-vision/src/native/doctr-ffi.ts`.

## Convert weights (when implemented)

```bash
python scripts/convert.py \
  --variant db_mobilenet_v3_large \
  --out vision/doctr-det.gguf

python scripts/convert.py \
  --variant crnn_mobilenet_v3_small \
  --out vision/doctr-rec.gguf
```

The detection variant writes a single tensor graph + mean/std metadata.
The recognition variant additionally writes the character vocabulary as a
`doctr.charset` KV entry inside the GGUF file.

## ABI

See `include/doctr.h`. The ABI is intentionally minimal:

```c
doctr_det_ctx * doctr_det_init(const char * gguf_path);
int  doctr_det_run(doctr_det_ctx *, const float * rgb_chw, int h, int w,
                   float * out_prob, int * out_h, int * out_w);
void doctr_det_free(doctr_det_ctx *);

doctr_rec_ctx * doctr_rec_init(const char * gguf_path);
int  doctr_rec_run(doctr_rec_ctx *, const float * rgb_chw, int h, int w,
                   float * out_logits, int * out_T, int * out_C);
const char * doctr_rec_charset(doctr_rec_ctx *);
void doctr_rec_free(doctr_rec_ctx *);
```
