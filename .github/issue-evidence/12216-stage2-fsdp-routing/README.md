# Stage 2 FSDP/APOLLO Routing Sanity Evidence

Issue: #12319

## Change Proven

- `train_local.py` now fails closed if APOLLO's pre-FSDP 2-D low-rank
  parameter names disappear before optimizer construction.
- The guard catches FSDP flatten/rename cases that would silently route all
  trainable weights into the non-projected APOLLO group.
- CPU-only regression tests cover:
  - normal unwrapped names,
  - `_fsdp_wrapped_module.` prefix stripping,
  - flattened FSDP names raising a loud `RuntimeError`.

## Verification

Run from `/Users/shawwalters/eliza-stage2-fsdp-routing` on July 4, 2026:

```bash
python3 -m pytest packages/training/scripts/test_train_local_low_vram_smoke.py -q
```

Result:

```text
.........................                                                [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/train_local.py \
  packages/training/scripts/test_train_local_low_vram_smoke.py
```

Result: exit code 0.

## Evidence Applicability

- Screenshots/video: N/A. This is a CLI trainer optimizer-routing guard with no
  UI surface.
- Live LLM trajectory: N/A. This change does not alter agent behavior,
  prompts, actions, providers, or model outputs.
- Backend/frontend logs: N/A. The relevant observable artifact is the trainer
  failing before optimizer construction on a bad FSDP parameter-name shape.
