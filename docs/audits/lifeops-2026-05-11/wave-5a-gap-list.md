# Wave 5-A — gap list (for W5-B and follow-ups)

Generated 2026-05-11. After-rebuild snapshot of known issues, organized by
severity. Prior W5-A run hit the Cerebras rate limit before finishing; this
list is the regenerated gap inventory after resumption. W5-B
(`6ef80720a9`) ran in parallel and resolved the four pre-assigned items as
no-ops (already green on `develop`).

Cross-links: [`REPORT.md`](./REPORT.md) (canonical summary),
[`rebaseline-report.md`](./rebaseline-report.md) (Wave-3 follow-ups),
[`scorer-fixes.md`](./scorer-fixes.md) (W4-A scorer bugs), and
[`eliza-1-status.md`](./eliza-1-status.md) (per-bundle release gates).

## P0 — would-block-ship items

None. The pre-existing P0 items called out in
[`rebaseline-report.md`](./rebaseline-report.md) are all resolved on
`develop`:

- Scorer name-aliasing (`CALENDAR_*` → `CALENDAR(subaction=*)`) — fixed in
  `w4-a` (`919a8ece35`), see [`scorer-fixes.md`](./scorer-fixes.md).
- Soft `intent` kwarg in `_kwargs_match` — fixed in same commit.
- Cerebras 429 / backoff — fixed in `w4-c` (`ef707bfd11`), see
  [`cerebras-backoff.md`](./cerebras-backoff.md).
- `BLOCK` vs `CALENDAR_CREATE_EVENT` planner confusion — fixed in `w4-d`
  (`d01f762c64`), see [`planner-disambiguation-fix.md`](./planner-disambiguation-fix.md).

The eliza bench-server LLM endpoint 404 remains a P0 for **eliza-1 agent
runs** but is out of scope for the pipeline rebuild (P3 below) — the
benchmark pipeline itself ships green on hermes + openclaw.

## P1 — high-confidence small fixes for W5-B

The four items the W5-B brief was told to fix are all no-op:

1. **`packages/app-core/src/browser.ts` ambiguous `ConfigField` /
   `getPlugins`** — already disambiguated by explicit
   `export { type ConfigField, getPlugins }` after wildcard exports
   (`packages/app-core/src/browser.ts:51`). Full-repo typecheck clean.
2. **`plugin-music/src/plugin-compression.test.ts` `musicPlugin.actions`** —
   3 pass / 0 fail on current `develop`.
3. **`test_hermes_agent.py::test_build_hermes_agent_returns_open_ai_compat_agent`**
   — passing (1 of 6 in `test_hermes_agent.py`).
4. **`action-retrieval.test.ts` regex namespace scoring** — 8 pass / 0 fail.
   The bun-test matcher-state bug noted in
   [`known-typecheck-failures.md`](./known-typecheck-failures.md) was
   worked around by splitting the assertions.

Real P1 fixes surfaced by sanity-check after rebuild:

5. **`test_scenarios_corpus.py::test_every_action_name_exists_in_manifest`
   — 116 GT action names unknown to manifest** (`tests/test_scenarios_corpus.py:76`).
   Root cause: scenarios under `reminders.*`, `finance.*`, `travel.*`,
   `health.*`, `sleep.*` reference action names (`LIFE_CREATE`,
   `LIFE_COMPLETE`, `LIFE_SNOOZE`, `LIFE_REVIEW`, `LIFE_DELETE`,
   `LIFE_UPDATE`, `LIFE_SKIP`, `LIFE`, `MONEY_DASHBOARD`,
   `MONEY_LIST_TRANSACTIONS`, `MONEY_SUBSCRIPTION_AUDIT`,
   `MONEY_SUBSCRIPTION_CANCEL`, `MONEY_RECURRING_CHARGES`,
   `MONEY_SPENDING_SUMMARY`, `MONEY_SUBSCRIPTION_STATUS`, `BOOK_TRAVEL`,
   `HEALTH`, `SCHEDULED_TASK_CREATE`, `SCHEDULED_TASK_UPDATE`,
   `SCHEDULED_TASK_SNOOZE`) that aren't promoted into the action
   manifest. Fix scope: extend the manifest exporter's umbrella-promotion
   table (`_UMBRELLA_SUBACTIONS` in `runner.py` + matching entries in
   `eliza_lifeops_bench/manifest_export.py`), OR rewrite the affected GT
   scenarios to use the existing umbrella names. ~25-50 LoC.

6. **`test_scenarios_corpus.py::test_authoring_validator_accepts_a_real_scenario`
   — `subaction` rejected by validator on `CALENDAR`**
   (`tests/test_scenarios_corpus.py:237`). Root cause: the authoring
   validator (`validate_batch`) does not know that `subaction` is the
   discriminator kwarg on the `CALENDAR` umbrella, even though
   `compare_actions` does (via `_UMBRELLA_SUBACTIONS` in `scorer.py`).
   Fix scope: thread the same umbrella table into the validator's
   parameter-declaration check. ~10-20 LoC.

7. **`plugins/app-training/src/dspy/__tests__/` count mismatch** —
   [`REPORT.md`](./REPORT.md) test grid claims 11 dspy primitive tests;
   `bunx vitest run` reports 9. Either the count in `REPORT.md` is stale
   (2 tests were merged or removed) or 2 tests live under a path the
   `__tests__/` glob misses. Fix scope: reconcile the number (small).

## P2 — Document only (out of scope for this rebuild)

- **eliza-1 bench-server `AI_APICallError: Not Found`** — the in-repo
  bench server's `@elizaos/plugin-openai` path hits a Cerebras endpoint
  Cerebras doesn't expose. Either pin to `/v1/chat/completions` or add
  `@elizaos/plugin-cerebras` to the bench-server plugin chain. Per
  [`rebaseline-report.md`](./rebaseline-report.md) this is why eliza
  scored 25 zeros. Real fix lives outside this rebuild's scope but
  blocks any future eliza-bundle benchmark.
- **DFlash drafters missing for `eliza-1-0.6b` / `eliza-1-1.7b`** —
  per [`eliza-1-status.md`](./eliza-1-status.md), dflash server still
  spawns against base weights for these sizes but loses speculative
  decoding throughput. Per-bundle readiness, not pipeline.
- **`plugin-imessage` "not built" Wave-0 note** — does not reproduce on
  current `develop`; `dist/` is present. No action needed unless
  someone forces `rm -rf dist`.
- **`packages/core/src/services/message.ts:8385-8386`
  `ReplyGateDecision.gateMode` / `scope`** — Wave-0 typecheck failure
  no longer reproduces on `develop`. Documented for historical record.
- **Personality model-level gaps** — every agent fails
  `hold_style.aggressive.code.004` and `escalation.aggressive.code.004`
  per [`rebaseline-report.md`](./rebaseline-report.md). Cerebras
  gpt-oss-120b instruction-following limitation under aggressive
  register; not a harness bug.

## P3 — Tracked to follow-up

- **First real measured run of `MILADY_RETRIEVAL_MEASUREMENT=1`** —
  current `retrieval-funnel.{md,json}` is structurally correct but
  `counted samples: 0` because no full run yet emits measurement
  trajectories. First run should rerun `bun run lifeops:retrieval:funnel`
  + `lifeops:retrieval:pareto` and either update
  `packages/benchmarks/lib/src/retrieval-defaults.ts` constants or
  document the measured deltas.
- **Anthropic re-bench with DSPy-optimized planner** — current
  re-baseline is Cerebras-only (env's `ANTHROPIC_API_KEY` unset at
  W2-9 time).
- **Run other domains (`mail`, `reminders`, `contacts`, `finance`,
  `travel`, `health`)** — calendar slice is 25/25; suite has 100+
  scenarios across other domains. Per-domain numbers are very different
  (W1-3 hermes peaked on `mail` at 0.494; `calendar` is harder).
- **Plumb hermes per-turn `cost_usd` / `latency_ms` into `MessageTurn`**
  — `total_cost_usd` is wired (W1-3), per-turn granularity is not.
- **`smoke_static_calendar_01` "scheduled, deep work" substring** —
  required-output substring + W4-D's `BLOCK` simile fix should now
  unblock this scenario. Re-baseline run will confirm.
- **`eliza-1-*` bundle `final` flips** — every checklist item in
  [`eliza-1-status.md`](./eliza-1-status.md) needs to clear before the
  aggregator can stop stamping the pre-release banner. Tracked per
  bundle.

## Verification snapshot at gap-list time

```
bun run test:cache-stability                     10/10 pass
bunx vitest run packages/benchmarks/lib/__tests__ 44/44 pass
bunx vitest run plugins/app-training/src/dspy/__tests__   9/9 pass (REPORT.md claims 11 — P1#7)
bunx vitest run packages/core/.../action-retrieval.test.ts 8/8 pass
bunx vitest run plugins/plugin-music/.../plugin-compression.test.ts 3/3 pass
python -m pytest packages/benchmarks/lifeops-bench/tests/       1490/1497 (2 fail, 5 skipped — P1#5, P1#6)
python -m pytest tests/test_hermes_agent.py                     6/7 pass (1 skipped, target test green)
```

Failing tests at snapshot:

- `test_scenarios_corpus.py::test_every_action_name_exists_in_manifest` (P1#5)
- `test_scenarios_corpus.py::test_authoring_validator_accepts_a_real_scenario` (P1#6)

Skipped tests (not failures): all gated on optional API keys / external
services (Cerebras live, Anthropic live, telegram bridge, etc.).
