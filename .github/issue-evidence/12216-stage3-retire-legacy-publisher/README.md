# Stage 3/4 legacy publisher retirement evidence

Issues: #12320, #12321
PR: TBD

## Scope

This slice retires the half-alive single-GGUF publisher path that only accepted
the disconnected Qwen-shaped fused flow.

Changes:

- Removed `packages/training/scripts/publish_eliza1_model.py`.
- Removed `publish_model.py --mode optimized`.
- Kept the two supported model publish modes:
  - `--mode bundle` -> `scripts.publish.orchestrator`
  - `--mode tier` -> `scripts.publish.publish_eliza1_model_repo`
- Replaced old fused-publisher tests with dispatcher coverage that proves
  `optimized` is rejected.
- Updated `packages/training/CLAUDE.md` and `AGENTS.md` together.

## Verification

```bash
python3 -m pytest packages/training/scripts/test_hf_publish.py -q -k 'publish_model'
```

Result:

```text
...                                                                      [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/publish/publish_model.py \
  packages/training/scripts/test_hf_publish.py \
  packages/training/scripts/verify_signature.py \
  packages/training/scripts/push_model_to_hf.py
```

Result: exit 0.

```bash
cmp -s packages/training/CLAUDE.md packages/training/AGENTS.md; echo $?
```

Result:

```text
0
```

## Notes

This does not remove every legacy quantization wrapper. It closes the published
artifact escape route for the old fused single-GGUF path, so nightly/operator
publishing can no longer route through a script that rejects the shipped Gemma
Q4_K_M bundle format.
