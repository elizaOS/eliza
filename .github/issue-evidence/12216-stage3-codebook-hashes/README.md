# Stage 3 Codebook Content Hash Evidence

Issue: #12320

## Change Proven

- `_kernel_manifest.py` no longer emits descriptive `codebook_hash` labels.
- Manifest fragments now use real `sha256:<digest>` values computed from the
  committed kernel/codebook source content:
  - TurboQuant 3-bit and 4-bit C codebook initializers.
  - TurboQuant TCQ 512-entry C codebook initializer.
  - PolarQuant Q4 centroid C initializer.
  - QJL public packed-layout header, because QJL is sign-only and has no
    centroid table.
- Import-time parity compares computed digests to pinned digests and fails
  loudly on drift.

## Verification

Run from `/Users/shawwalters/eliza-stage3-codebook-hashes` on July 4, 2026:

```bash
python3 -m pytest \
  packages/training/scripts/quantization/test_recipes_smoke.py \
  -q -k 'kernel_manifest or polarquant_centroids'
```

Result:

```text
...                                                                      [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/quantization/_kernel_manifest.py \
  packages/training/scripts/quantization/test_recipes_smoke.py
```

Result: exit code 0.

Broader smoke attempt:

```bash
python3 -m pytest packages/training/scripts/quantization/test_recipes_smoke.py -q
```

Result: blocked by the local Python environment before the changed manifest
tests were reached in many cases. `transformers` rejected the installed
`huggingface-hub==1.15.0` because it requires `huggingface-hub>=0.23.2,<1.0`.
The focused zero-dependency manifest/hash tests above do not import
`transformers` and passed.

Manifest digest spot-check:

```text
polar_q4: sha256:cce740dff7143a258ea01a482a539f2485acc959895e8dbc3ce2945f034ec329
turbo3: sha256:edc3ccfadf06e038e79d9dd763b89a6fb359742521ddf1950fe7b40fe55f0a5e
turbo4: sha256:2e8b3c0c2668f3e2243734a0b679ea57d333b5509fea097122afce8066b959a5
turbo3_tcq: sha256:df82e32eed0df23f5a88fe9afbb077a03e3067c8690dcc55997ad01fb54e96be
qjl1_256: sha256:84048dea7812cf87e0c002aa2be69443e4228c10b326a9e5b1aa2d3668fbab58
```

## Evidence Applicability

- Screenshots/video: N/A. This is a CLI manifest/parity guard with no UI
  surface.
- Live LLM trajectory: N/A. This change does not alter agent behavior,
  prompts, actions, providers, or model outputs.
- Backend/frontend logs: N/A. The relevant observable artifact is
  publish-manifest metadata and the parity test failing on kernel source drift.
