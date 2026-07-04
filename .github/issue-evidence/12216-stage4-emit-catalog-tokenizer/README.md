# Stage 4 emit catalog tokenizer-family evidence

Issue: #12321
PR: TBD

## Scope

This slice removes the catalog emitter's hardcoded tokenizer-family table.

`packages/training/scripts/emit_eliza1_catalog.py` now requires
`manifest.tokenizer.family` and emits that value into `tokenizerFamily`.
The tier metadata table still owns display/catalog sizing defaults, but it no
longer stamps every tier as `gemma4`. This keeps the emitter aligned with the
manifest builder's byte-level tokenizer/architecture gate instead of inventing
tokenizer identity locally.

## Verification

```bash
python3 -m pytest packages/training/scripts/test_emit_eliza1_catalog.py -q
```

Result:

```text
....                                                                     [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/emit_eliza1_catalog.py \
  packages/training/scripts/test_emit_eliza1_catalog.py
```

Result: exit 0.

```bash
grep -RIn "tokenizer_family.*gemma4\\|tokenizerFamily.*gemma4" \
  packages/training/scripts/emit_eliza1_catalog.py \
  packages/training/scripts/test_emit_eliza1_catalog.py
```

Result: only the positive Gemma fixture assertion remains; the emitter has no
hardcoded `tokenizer_family = gemma4` table entry.

## Notes

The emitter receives a manifest path, not a GGUF path. It now consumes tokenizer
identity from the manifest so the separate manifest byte-architecture gate can
be the source of truth.
