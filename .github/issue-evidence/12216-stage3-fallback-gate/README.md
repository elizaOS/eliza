# Stage 3 GGUF fallback gate evidence

Issue: #12320
PR: TBD

## Scope

This slice removes the release escape hatch from
`packages/training/scripts/quantization/gguf_eliza1_apply.py
--allow-unoptimized-fallback`.

The flag remains available for local debugging, but fallback output is now
marked `weight_quant.releaseEligible=false` and is rejected whenever
`--release-state` is present. A release-labeled GGUF can no longer fall back
from `q4_polar` to `f16`/`q8_0`.

## Verification

```bash
bun install
```

Result: exit 0; artifacts synced to `2026-06-18.1`.

```bash
python3 -m pytest packages/training/scripts/quantization/test_gguf_eliza1_apply.py -q
```

Result:

```text
.....                                                                    [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/quantization/gguf_eliza1_apply.py \
  packages/training/scripts/quantization/test_gguf_eliza1_apply.py
```

Result: exit 0.

## Notes

This is a flag-gating regression, not a full artifact conversion. Full real-GGUF
recipe/publish evidence remains with the broader Stage 3 and Stage 4 checklist
items.
