# H7 — Anthropic re-bench readiness (no-key dry-run path verification)

**Date**: 2026-05-11
**Wave**: 7
**Item**: RUNBOOK §2 — Anthropic re-bench with DSPy-optimized planner (P3#2)
**Status**: BLOCKED on missing `ANTHROPIC_API_KEY`; multi-tier pipeline verified end-to-end via dry-run.

## TL;DR

The Anthropic re-bench cannot run on this checkout because `ANTHROPIC_API_KEY`
is empty in `/Users/shawwalters/milaidy/eliza/.env` (the placeholder
`ANTHROPIC_API_KEY=` exists on line 58 of `.env.example` and the same key is
unset in the live `.env`). The benchmark pipeline correctly detects the missing
credential and **skips-not-fails** the frontier cell, so re-running with a key
later is a single-command operation with no code changes required.

This doc confirms the resolution chain, the smoke suite shape, and the exact
operator command to run once a key is available.

## Frontier tier resolution

`MODEL_TIER=frontier` resolves consistently on both sides of the pipeline.

### TypeScript (`packages/benchmarks/lib/src/model-tiers.ts`)

```
MODEL_TIER=frontier ⇒ {
  tier:           "frontier",
  provider:       "anthropic",
  modelName:      "claude-opus-4-7",
  contextWindow:  200000,
  notes:          "Production runtime"
}
```

### Python (`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/model_tiers.py`)

```
tier:            frontier
provider:        anthropic
model:           claude-opus-4-7
base_url:        None  (SDK default = https://api.anthropic.com)
context_window:  200000
```

### Client wiring

`eliza_lifeops_bench/clients/anthropic.py` calls `self._client.messages.create(...)`
via the official `anthropic` Python SDK. The endpoint is whatever the SDK
defaults to (`https://api.anthropic.com/v1/messages`). The API key is read
from `os.environ["ANTHROPIC_API_KEY"]` at line 258. Default model:
`claude-opus-4-7` (line 42), matching the tier registry.

Pricing constants embedded in the client (Opus tier):
- input:        $15.00 / 1M tokens
- output:       $75.00 / 1M tokens
- cache-read:    $1.50 / 1M tokens

## Smoke suite

`SMOKE_SCENARIOS` (from `eliza_lifeops_bench/suites.py`) = **5 named scenarios**:

1. `calendar.check_availability_thursday_morning`
2. `mail.archive_specific_newsletter_thread`
3. `reminders.create_pickup_reminder_tomorrow_9am`
4. `health.step_count_today`
5. `messages.send_imessage_to_hannah`

The multi-tier driver fans out smoke across three harnesses (`hermes`,
`openclaw`, `eliza`) so a single `--tiers frontier` smoke run executes
**5 scenarios × 3 harnesses = 15 cells** end-to-end against Anthropic.

## Dry-run verification

Command issued:

```
node scripts/lifeops-multi-tier-bench.mjs --suite smoke --tiers frontier \
  --harnesses hermes,openclaw,eliza --dry-run
```

Output (paraphrased — see `~/.eliza/runs/lifeops/lifeops-multi-tier-2026-05-12T05-25-29-801Z/dry-run-plan.json`):

```
[multi-tier] suite=smoke tiers=frontier harnesses=hermes,openclaw,eliza
[multi-tier] dflash binary: (absent)
[multi-tier]  - frontier/hermes:   SKIP (ANTHROPIC_API_KEY not in env)
[multi-tier]  - frontier/openclaw: SKIP (ANTHROPIC_API_KEY not in env)
[multi-tier]  - frontier/eliza:    SKIP (ANTHROPIC_API_KEY not in env)
```

The plan file contains exact `python3 -m eliza_lifeops_bench --suite smoke
--agent <harness> --mode static --model-tier frontier --output-dir <dir>`
invocations per cell with `MODEL_TIER=frontier` and `PYTHONUNBUFFERED=1`
in the cell env. No subprocess was spawned (dry-run).

## Code-path sanity (no live API)

| Check | Result |
|---|---|
| `bunx tsc --noEmit -p packages/benchmarks/lib/tsconfig.json` | clean (no errors) |
| `bun test packages/benchmarks/lib/src/__tests__/model-tiers.test.ts` | 11 pass / 0 fail / 27 expect() calls |
| Frontier tier resolution (TS) | `anthropic` / `claude-opus-4-7` / 200k ctx |
| Frontier tier resolution (Py) | `anthropic` / `claude-opus-4-7` / 200k ctx |
| Smoke suite scenario count | 5 |
| Multi-tier driver skip-not-fail on missing key | confirmed via dry-run |

## What the operator needs to do

1. Obtain an Anthropic API key with **Opus 4.7** access on the plan.
2. Add it to `/Users/shawwalters/milaidy/eliza/.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. (Optional, if the key's plan does not include Opus 4.7) Pin a fallback
   model via env override:
   ```
   MODEL_NAME_OVERRIDE=claude-opus-4-5-20251001
   # or
   MODEL_NAME_OVERRIDE=claude-sonnet-4-6
   ```
   The override is read by `resolveTier()` in `model-tiers.ts` without
   touching the source. Note: the Python `anthropic` client's
   `ANTHROPIC_PRICING` table only contains `claude-opus-4-7` and
   `claude-haiku-4-5-20251001` — a non-Opus override will compute cost
   against an unknown SKU and may emit zero-cost entries.
4. **The single command to issue**:

   ```bash
   bun run lifeops:multi-tier:smoke -- --tiers frontier
   ```

   Estimated runtime per RUNBOOK §2: 10–20 min. Output lands at
   `~/.eliza/runs/lifeops/lifeops-multi-tier-<ts>/` with per-cell
   `report.json` + `report.md`, a top-level `SUMMARY.md`, and pairwise
   delta directories if any other tier is also present in the run.

5. After completion, diff against the most recent Cerebras smoke baseline
   (the current rebaseline is calendar-only and lives elsewhere; a fresh
   Cerebras smoke run may be needed for an apples-to-apples comparison):

   ```bash
   bun run lifeops:delta -- \
     --baseline <cerebras-report.json> \
     --candidate <anthropic-report.json> \
     --out runs/h7-anthropic-vs-cerebras
   ```

## Why this was blocked

`ANTHROPIC_API_KEY` is absent from `.env` (only the example file has the
placeholder line `ANTHROPIC_API_KEY=` at `.env.example:58`). The current
rebaseline is therefore Cerebras-only, which is exactly the gap RUNBOOK §2
calls out: if the DSPy-optimized planner overfit to the Cerebras teacher,
a frontier re-bench would surface the regression. Until a key is provided,
we cannot answer the over-fit question — but the pipeline is ready to
answer it the moment a key lands.

## Artifacts

- Dry-run plan: `~/.eliza/runs/lifeops/lifeops-multi-tier-2026-05-12T05-25-29-801Z/dry-run-plan.json`
- Tier registry: `packages/benchmarks/lib/src/model-tiers.ts`
- Tier resolver (Python): `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/model_tiers.py`
- Smoke suite: `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/suites.py`
- Multi-tier driver: `scripts/lifeops-multi-tier-bench.mjs`
- Anthropic client: `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/clients/anthropic.py`
