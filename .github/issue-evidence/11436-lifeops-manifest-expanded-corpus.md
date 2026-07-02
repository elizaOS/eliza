# Issue 11436 - LifeOpsBench Expanded Corpus Manifest

Date: 2026-07-02
Branch: `fix/11436-lifeops-manifest-expanded-corpus`

## Change

- Extended the LifeOpsBench manifest augment so regenerated manifests cover
  benchmark-only expanded-corpus fields on scheduled tasks and selected live
  plugin action names.
- Kept the overlay narrow and explicit in
  `eliza_lifeops_bench.manifest_export`.
- Regenerated `manifests/actions.manifest.json` from the in-tree generator.
- Added regression coverage in `tests/test_manifest_export.py`.

## Reproduction

After #11417, the full package suite reached 97% and failed in:

```bash
python3 -m pytest tests/ -q
```

Observed failures:

- `tests/test_expanded_scenarios.py::test_expanded_scenarios_validate_against_manifest`
  rejected undeclared expanded-corpus kwargs on regenerated manifest actions.
- Initial missing fields included scheduled-task metadata/pipeline fields,
  blocker/travel/finance overlay fields, and numeric `BOOK_TRAVEL.passengers`.

## Verification

Passed:

```bash
bun run lifeops-bench:manifest
python3 -m pytest tests/test_manifest_export.py tests/test_expanded_scenarios.py::test_expanded_scenarios_validate_against_manifest tests/test_scenarios_corpus.py -q
python3 -m pytest tests/test_manifest_export.py tests/test_expanded_scenarios.py tests/test_scenarios_corpus.py -q
node --conditions=eliza-source --conditions=development --import tsx scripts/lifeops-bench/export-action-manifest.ts --out "$manifest_tmp" --summary-out "$summary_tmp"
diff -u packages/benchmarks/lifeops-bench/manifests/actions.manifest.json "$manifest_tmp"
diff -u packages/benchmarks/lifeops-bench/manifests/actions.summary.md "$summary_tmp"
bunx @biomejs/biome check scripts/lifeops-bench/export-action-manifest.ts package.json .github/workflows/lifeops-bench-manifest.yml --no-errors-on-unmatched
git diff --check
```

Results reviewed:

- Focused pytest: `21 passed`.
- Expanded + manifest + corpus pytest: `28 passed`.
- Drift check: regenerated manifest and summary matched committed artifacts.
- Manifest still reports `174` actions and `20` bench umbrella entries.

Known unrelated repo-level blocker:

```bash
bun run verify
```

Result: failed before typecheck/lint at the existing type-safety ratchet drift:

- `as unknown as: 80 current > 77 baseline`
- ``?? {}`` `(core/agent/app-core): 379 current > 377 baseline`

## N/A

- UI screenshots/video: N/A - benchmark manifest/schema tooling only.
- Live model trajectory: N/A - no model behavior changed; this fixes corpus
  validation against the generated manifest.
