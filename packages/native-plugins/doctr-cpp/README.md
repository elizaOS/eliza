# doctr-cpp

Standalone C library + GGUF conversion script that will port mindee's
[docTR](https://github.com/mindee/doctr) detection (`db_resnet50`)
and recognition (`crnn_vgg16_bn`) heads to the elizaOS/llama.cpp
fork's ggml dispatcher. The output replaces plugin-vision's
transitional `RapidOcrCoordAdapter` with a native hierarchical
(block / line / word) OCR provider.

Today this is a **stub**: the C ABI declared in
`include/doctr/doctr.h` is fully wired, every entry point returns
`-ENOSYS` from `src/doctr_stub.c`, and the build emits `libdoctr.a`
plus a `doctr_stub_smoke` binary that asserts the ABI still links and
reports the expected error code.

The full port plan — upstream pin, GGUF conversion approach, fork
integration steps, replacement path for the TS adapter — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native-plugins/doctr-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Layout

```
include/doctr/doctr.h        Public C ABI (frozen — see AGENTS.md).
src/doctr_stub.c             ENOSYS stub. Real TUs replace this.
scripts/doctr_to_gguf.py     Skeleton converter; TODO blocks documented.
test/doctr_stub_smoke.c      Build-only smoke test for the stub ABI.
CMakeLists.txt               Builds libdoctr + the smoke test.
```

## License

Apache 2.0 — matches mindee/doctr's license. The pinned upstream
commit recorded in `scripts/doctr_to_gguf.py` is the source of the
weights this library ships against.
