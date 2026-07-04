# NOTES — run metadata, trajectory review, environment findings, honest N/A rows (#12781 closeout)

## Exact commands (identical flags both sides)

```bash
# prompt benchmark (each side, from that side's tree root)
bun --conditions=eliza-source --tsconfig-override=<minimal tsconfig: jsx react-jsx, no paths> \
  plugins/plugin-personal-assistant/scripts/lifeops-prompt-benchmark.ts \
  --suite all --provider cerebras \
  --report prompt-benchmark-<side>.json \
  --markdown prompt-benchmark-<side>.md \
  --ax prompt-benchmark-<side>.ax.jsonl

# timeliness gate (each side, keyless, deterministic)
TZ=UTC bun run --cwd packages/benchmarks/lifeops-quality bench:timeliness

# lifeops-bench (each side, from packages/benchmarks/lifeops-bench)
ELIZA_BENCH_SERVER_CMD="bun --conditions=eliza-source --tsconfig-override=<nopaths> --no-env-file run" \
uv run python -m eliza_lifeops_bench --agent eliza --suite core --mode static \
  --concurrency 1 --per-scenario-timeout-s 300 --max-cost-usd 10 --output-dir <out>/core-static
# + 8x: ... --agent eliza --scenario control.<id> ... --output-dir <out>/f1-controls
```

Runs were serialized (after prompt + before prompt, then LOB after, then LOB
before) to keep Cerebras load flat. All LOB harness exits were 0 (recorded in
the committed `core-static.log` / `f1-controls.log`).

## Trajectory manual review (per the evidence standard: artifacts READ, not just captured)

Spot-read >= 6 per-case trajectories per side from the ax.jsonl files
(regressed, improved, subtle-null, and stable cases). Findings:

1. **Zero-call harness dropouts explain most case-level movement.** 55 (before)
   / 56 (after) of 398 cases record `llmCallCount=0` with empty
   observed/responseText — these are the cases the reports count as
   trajectory-capture misses (86.2% / 85.9% capture) and they always score as
   fails. They are symmetric across sides. Of the 15 pass->fail case ids, 9 are
   after-side dropouts; of the 12 fail->pass, 8 are before-side dropouts.
   Movement among cases that genuinely executed on BOTH sides: 6 regressed vs
   4 improved on 398 cases — single-run noise, not signal.
2. **`ea.followup.repair-missed-call-and-reschedule` never executes** — all 11
   variants are zero-call dropouts on BOTH sides. Pre-existing harness/scenario
   issue, unrelated to D1-D3; flagged for follow-up.
3. **TrajectoryLimitExceeded recurs on both sides**: 11 incidents before, 9
   after, all `required_tool_misses (4/3)` — the benchmark's own guard tripping
   when the model repeatedly misses required tools; roughly symmetric, not a
   D1-D3 effect.
4. Executed trajectories look healthy on both sides: grounded planner prompts,
   coherent user-facing replies, correct null-case restraint (e.g.
   `workout-blocker-basic__subtle-null` correctly holds off on both sides with
   `action: null` and a defer reply). The known #12150 strict-schema warnings
   (free-form record args degraded to `additionalProperties:false`) appear
   throughout both logs — pre-existing repo-wide issue, identical both sides.
5. Timeliness gate durations differ (before 28.7s total / 20.0s tests; after
   789.5s total / 662.8s tests). Both PASSED with deviations inside the
   committed budgets; the wall-clock difference is not scored by the gate and
   is at least partly lane/cold-cache overhead (transform 174s vs 9.6s). Noted
   for transparency.

## Environment findings hit while producing this evidence (all pre-existing, none introduced here)

1. **Stale in-src build artifacts poison the vitest gate lanes.** A worktree
   that previously ran package builds accumulates git-ignored `*.js`/`*.d.ts`
   files NEXT TO the `.ts` sources (e.g.
   `packages/core/src/utils/context-catalog.js`). Vite resolves extensionless
   relative imports `.js`-first, so a stale compiled `context-catalog.js`
   (predating `lookupProviderCatalogContexts`) shadows the fresh `.ts` and the
   timeliness gate dies with `TypeError: lookupProviderCatalogContexts is not a
   function`. Fix used here: delete all untracked+ignored in-src `*.js`/`*.d.ts`
   artifacts (2433 files in the lane) — the gate then runs the real sources.
   This is a false-RED hazard for anyone re-running the gate in a used lane.
2. **`bun run build` (root) fails on develop tip** with
   `Cyclic dependency detected: @elizaos/plugin-local-inference#build <-> @elizaos/agent#build`.
   The same root build at the before-SHA (9ab1e596a) completes, so the cycle
   was introduced between 9ab1e596a and 08b5e87ff (PR #13331 window). Does not
   affect this evidence: runs executed in bun source-mode / prebuilt-dist
   worktrees. Reported upstream on #13331.
3. **bun + app-core tsconfig paths break bun-direct execution** of the prompt
   benchmark CLI: `packages/app-core/tsconfig.json` maps `react/jsx-runtime` to
   `@types/react/*.d.ts`, and bun honors tsconfig paths at runtime, so any
   import crossing the app-core barrel crashes with
   `Cannot find module './' from @types/react/jsx-runtime.d.ts`. The
   lifeops-bench eliza-adapter's server_manager already documents this hazard.
   Workaround used here (both sides identically): `bun --conditions=eliza-source
   --tsconfig-override=<minimal tsconfig with jsx:react-jsx and no paths>`.

## Honest N/A rows

| row | status |
|---|---|
| LifeOpsBench LIVE mode (`--mode live`, simulated user + judge) | N/A - requires ANTHROPIC_API_KEY for the claude-opus judge; only CEREBRAS_API_KEY is available in this environment. Static mode (state-hash scored, judge-free) was run instead — the honest judge-free subset. |
| LifeOpsBench `--suite full` (15378 scenarios) live | N/A - impractical against a live runtime in one session (est. > 100h serial); bounded core-static suite (30 scenarios) + full F1 static control set run instead, per the issue's own escape hatch ("a bounded --limit is acceptable if full is impractical — document"). Corpus integrity for the FULL suite verified both sides via `--agent perfect --dry-run` (15378 scenarios resolved, before AND after). |
| D7 crisis-language guard | N/A - #12780 closed NOT_PLANNED (descoped by owner); per the #12781 thread the closeout treats it as a deliberate non-goal. |
