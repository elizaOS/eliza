# Issue 11382 - LifeOpsBench manifest regeneration evidence

Date: 2026-07-02
Branch: `fix/11382-lifeops-manifest-regeneration`

## What changed

- Restored an in-tree manifest generator:
  `scripts/lifeops-bench/export-action-manifest.ts`.
- Added root command:
  `bun run lifeops-bench:manifest`.
- Unignored and committed
  `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`.
- Updated the drift gate to regenerate the manifest and summary from scratch,
  then diff both committed artifacts.
- Updated LifeOpsBench README/CLAUDE/AGENTS/authoring references.

## Regeneration proof

Command:

```bash
bun run lifeops-bench:manifest
```

Reviewed output:

```text
patched .../packages/benchmarks/lifeops-bench/manifests/actions.manifest.json (+20 bench umbrella entries)
wrote .../packages/benchmarks/lifeops-bench/manifests/actions.manifest.json (174 actions) and .../packages/benchmarks/lifeops-bench/manifests/actions.summary.md
```

Committed manifest metadata was inspected manually:

- `schemaVersion`: `1`
- `generator`: `scripts/lifeops-bench/export-action-manifest.ts`
- `sourcePlugins`: contacts, personal-assistant, phone, BlueBubbles, iMessage,
  todos
- action count: `174`
- plugin breakdown: `153` personal-assistant, `1` todos, `20` bench umbrella

CI-style drift check:

```bash
tmp="$(mktemp)"
summary_tmp="$(mktemp)"
node --conditions=eliza-source --conditions=development --import tsx \
  scripts/lifeops-bench/export-action-manifest.ts \
  --out "$tmp" \
  --summary-out "$summary_tmp"
diff -u packages/benchmarks/lifeops-bench/manifests/actions.manifest.json "$tmp"
diff -u packages/benchmarks/lifeops-bench/manifests/actions.summary.md "$summary_tmp"
```

Result: both diffs were empty.

## Test evidence

Focused manifest + corpus tests:

```bash
python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_manifest_export.py \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py
```

Result: `18 passed in 0.21s`.

No-key smoke harness run:

```bash
python3 -m eliza_lifeops_bench --agent perfect --suite smoke
```

Reviewed artifact:
`.github/issue-evidence/11382-lifeops-manifest-smoke.json`

Result: `5` scenarios, `pass@1 = 1.000`, `pass@k = 1.000`.

Real-model static run:

```bash
python3 -m eliza_lifeops_bench \
  --agent cerebras-direct \
  --mode static \
  --scenario calendar.check_availability_thursday_morning \
  --concurrency 1 \
  --max-cost-usd 0.05 \
  --output-dir ../../../.github/issue-evidence
```

Reviewed artifact:
`.github/issue-evidence/11382-lifeops-manifest-cerebras-static.json`

Result: Cerebras `gemma-4-31b`, `1` scenario, `pass@1 = 1.000`,
`pass@k = 1.000`, first tool call `CALENDAR_CHECK_AVAILABILITY`.

Repo verify:

```bash
bun run verify
```

Result: failed before typecheck/lint at the existing type-safety ratchet drift:

- `as unknown as: 80 current > 77 baseline`
- ``?? {}`` `(core/agent/app-core): 379 current > 377 baseline`

## N/A

- UI screenshots/video: N/A - command-line manifest/tooling change only.
- Frontend console/network logs: N/A - no frontend path changed.
