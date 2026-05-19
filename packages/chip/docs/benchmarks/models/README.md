# Benchmark Model Artifacts

Place redistributable benchmark models in this directory.

The harness expects `mobile_smoke.tflite` for the TensorFlow Lite CPU and e1
NPU entries. Do not commit proprietary vendor, app, or benchmark-suite models.
You can generate the smoke model without network access when TensorFlow is
already installed:

```sh
python3 benchmarks/models/generate_mobile_smoke_tflite.py \
  --out benchmarks/models/mobile_smoke.tflite
```

If TensorFlow is not installed, the generator exits with code `2` and emits a
JSON blocker instead of downloading dependencies. Until a real model is supplied,
those benchmarks report status `blocked` rather than producing performance
claims from a placeholder file.

Current acceptance rule:

- `benchmarks/models/mobile_smoke.tflite` must exist.
- It must be at least 4096 bytes.
- If a future plan pins `sha256`, the file must match that digest.
- Missing, placeholder, or mismatched models are reported with stable blocker
  metadata for CI and release gates.
