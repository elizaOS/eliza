# Stage 4 HF catalog sync org evidence

Issue: #12321
PR: TBD

## Scope

This slice fixes the HF catalog sync slop item for
`packages/training/scripts/sync_catalog_from_hf.py`.

The script now defaults to the live Eliza-1 Hugging Face org, `elizaos`, and
the usage examples/diff schema documentation no longer point operators at the
stale `elizalabs` org.

## Verification

```bash
python3 -m pytest packages/training/scripts/test_hf_publish.py -q -k 'sync_catalog'
```

Result:

```text
....                                                                     [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/sync_catalog_from_hf.py \
  packages/training/scripts/test_hf_publish.py
```

Result: exit 0.

```bash
grep -RIn "default: elizalabs\\|--org elizalabs\\|\\\"org\\\": \\\"elizalabs\\\"\\|under the elizalabs" \
  packages/training/scripts/sync_catalog_from_hf.py \
  packages/training/scripts/test_hf_publish.py \
  packages/training/CLAUDE.md \
  packages/training/AGENTS.md
```

Result: exit 0 with no matches.

## Notes

No live Hugging Face scan was needed for this slice; the regression test mocks
collection and verifies the CLI default passed into `collect_entries` and
`write_diff`.
