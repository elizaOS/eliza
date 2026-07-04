# Stage 4 manifest text-architecture gate evidence

Issue: #12321
PR: TBD

## Scope

This slice adds a Python-side byte metadata gate for Eliza-1 text GGUFs.

`packages/training/scripts/manifest/eliza1_manifest.py` now reads
`general.architecture` from the GGUF header, carries that architecture on
internal `FileEntry` records, and rejects manifest builds when a text GGUF
reports a non-Gemma architecture such as `qwen35`.

The real staging paths that have access to actual GGUF paths now populate this
field:

- `packages/training/scripts/manifest/stage_real_eliza1_bundle.py`
- `packages/training/scripts/manifest/stage_local_eliza1_bundle.py`
- `packages/training/scripts/publish/orchestrator.py`
- `packages/training/scripts/publish/stage_base_v1_candidate.py`

## Verification

```bash
python3 -m pytest packages/training/scripts/manifest/test_eliza1_manifest.py -q
```

Result:

```text
........................................................................ [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/manifest/eliza1_manifest.py \
  packages/training/scripts/manifest/test_eliza1_manifest.py \
  packages/training/scripts/manifest/stage_real_eliza1_bundle.py \
  packages/training/scripts/manifest/stage_local_eliza1_bundle.py \
  packages/training/scripts/publish/orchestrator.py \
  packages/training/scripts/publish/stage_base_v1_candidate.py
```

Result: exit 0.

## Notes

The regression uses a minimal GGUF header fixture with
`general.architecture=qwen35` and confirms `build_manifest()` raises
`Eliza1ManifestError`. A full live HF qwen35 bundle audit remains part of the
broader Stage 4 HF-audit checklist item.
