# Vendored PolarQuant core

Two files vendored verbatim from
[`caiovicentino/eoq-quantization`](https://github.com/caiovicentino/eoq-quantization)
@ commit `15a12160245d7d3015290c6c5b6dbb7f22094d5e`:

- `polar_quant.py` — the actual PolarQuant algorithm (per-block normalize →
  Walsh-Hadamard rotation → Lloyd-Max quantizer matched to N(0,1) →
  optional 1-bit QJL residual correction).
- `utils.py` — `QuantizedTensor`, `quantize_absmax`, `dequantize`, and the
  entropy-estimation helper. `polar_quant.py` only depends on `utils` from
  inside the `compare_polar_vs_absmax` helper, so the rest of the pipeline
  works without it; we still vendor `utils.py` so that helper stays usable.

Paper: *PolarQuant: Optimal Gaussian Weight Quantization via Hadamard Rotation
for LLM Compression*, Caio Vicentino, arXiv:2603.29078 (March 2026).

See `LICENSE.md` for the upstream license situation (currently: no license
file in the upstream repo; vendored under the constraints documented there).

The integration glue that calls into these modules from a HuggingFace
checkpoint lives one directory up in `polarquant_apply.py`; do not modify
the vendored files in place — patch upstream and re-vendor instead.
