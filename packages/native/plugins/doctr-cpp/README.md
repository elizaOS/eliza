# doctr-cpp

Standalone C library + GGUF conversion script that ports mindee's
[docTR](https://github.com/mindee/doctr) detection (`db_resnet50`)
and recognition (`crnn_vgg16_bn`) heads to a native CPU reference
runtime. The output replaces plugin-vision's transitional
`RapidOcrCoordAdapter` with a native hierarchical (block / line / word)
OCR provider once production parity rollout completes.

Today the C ABI declared in `include/doctr/doctr.h` is wired through
`src/doctr_runtime.c` to the pure-C detector and recognizer reference
forwards. The build emits `libdoctr.a` plus a `doctr_abi_smoke` binary
that asserts the ABI still links and reports expected error contracts.

The full port plan — upstream pin, GGUF conversion approach, fork
integration steps, replacement path for the TS adapter — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native/plugins/doctr-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Layout

```
include/doctr/doctr.h        Public C ABI (frozen — see AGENTS.md).
src/doctr_runtime.c          Public ABI/session glue.
src/doctr_detector_ref.c     Native CPU detector forward.
src/doctr_recognizer_ref.c   Native CPU recognizer forward.
src/doctr_*.c                GGUF reader, image helpers, kernels, CTC.
scripts/doctr_to_gguf.py     docTR-to-GGUF converter.
test/doctr_abi_smoke.c       Build-only smoke test for the public ABI.
CMakeLists.txt               Builds libdoctr + native tests.
```

## License

Apache 2.0 — matches mindee/doctr's license. The pinned upstream
commit recorded in `scripts/doctr_to_gguf.py` is the source of the
weights this library ships against.
