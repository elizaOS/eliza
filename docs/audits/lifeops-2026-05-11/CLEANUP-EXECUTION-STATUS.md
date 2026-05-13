# Cleanup execution status — 2026-05-11

Companion to [`SYNTHESIS-IMPLEMENTATION-PLAN.md`](./SYNTHESIS-IMPLEMENTATION-PLAN.md).
Tracks what's landed during the multi-week prompt-optimization + benchmarking +
trajectory + voice cleanup, what's in flight, and what's still to do.

> All work happens on `develop`. Per-phase commits. Push proactively.
> Multiple Claude sessions are working concurrently — coordinate via this
> doc, not by ad-hoc retro-fitting.

---

## Phases (my own roadmap)

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Refresh ground truth — fresh baselines | ✅ Done | `final-rebaseline-report.md` snapshot is current (2026-05-11). eliza 0.518 / hermes 0.480 / openclaw 0.505 on lifeops calendar 25; personality eliza-runtime 64%. |
| 1 | Close bench→optimizer loop + holdout gate | ✅ Done | `splitTrainHoldout` + `holdoutSet` plumbing. 24/24 tests pass. Commit `76add4ddd8`. |
| 2 | Consolidate 4 Cerebras judge wrappers | ✅ Done | `53e97402c0` wave-7-h6 — `CerebrasJudge` extracted to `packages/scenario-runner/src/cerebras-judge.ts`; all 4 callers migrated. |
| 3 | Adapter parity + transport dedup | ✅ Done | `BaseBenchmarkClient` extracted to `packages/benchmarks/lib/`. All three adapters subclass + override `_send`. **Eliza $0 cost bug fixed** (server.ts propagates `usage` to HTTP response). 164 tests pass. Commit `6e1d8b200d`. |
| 4 | Voice benchmarks (VoiceBench, MMAU, VoiceAgentBench) | ✅ Done | VoiceBench `b82b302ccc`, MMAU `dc24e51b4c`, VoiceAgentBench `737fa7b27c`. |
| 5 | Registry split + stub purge | ✅ Done | `587fa85b41` — 3745-line `registry.py` split into `registry/{__init__,scores,commands}.py`. 134 tests pass. No actual stubs found in this file. |
| 6 | Python ↔ TS training bridge | ✅ Done | `local_path` source type, `eval_checkpoint.py` writes to W0-X5 store, `eliza-nightly-*` dataset entries. 18 new tests + 30 results-store regression tests pass. Commit `ae912c3450`. |
| 7 | Formal GEPA (Goyal et al. 2024) | ✅ Done | `84f2db9b9897` — `runGepa` implemented in `native.ts` dispatcher. |
| 8 | Continuous Cerebras grind in CI | ✅ Done | `cerebras-nightly.yml` + `cerebras-nightly-delta.py`. Commit `62ebaac31a`. |

---

## Synthesis P0s (from synthesis plan §10)

| # | Item | Status | Branch / Commit |
|---|---|---|---|
| P0-1 | Extend `scorer._UMBRELLA_SUBACTIONS` beyond CALENDAR + MESSAGE | ✅ Done | Commit `55df0bd006` + parallel-session augmentation `48ab9f1d7e`. +105 scorer tests; 970 conformance tests pass. |
| P0-2 | Wire `STYLE_KEY_TO_STYLE` / `TRAIT_KEY_TO_OPTIONS` bridge keys | ✅ Done | `3c110b40d8` — extracts bridge into `scripts/personality-bench-bridge.mjs` + 20 unit tests. |
| P0-3 | LLM-judge JSON parse + `response_format: json_object` | ✅ Done | `661107e6a5` — 12 parser tests. |
| P0-4 | MESSAGE umbrella in TS fake backend | ✅ Done | `b9556447bd` — mirrors Python `_u_message` so eliza mail scores move off 0.000. |
| P0-5 | CALENDAR umbrella → `lifeops.calendar.*` routing | ✅ Done | `4d89b51c61` — `translateUmbrellaAction` in `lifeops-bench-handler.ts`. 18 tests pass. |
| P0-6 | Inline LIFE_CREATE wire shape into `_TOOL_DESCRIPTIONS` | ✅ Done | `9ca07f32e8` + `0aa9727223` — 18 tests pass. |
| P0-7 | Bench-server role seeding for `scope_global_vs_user` | ✅ Done | `53e97402c0` wave-7-h6 — reset payload + `PersonalityStore.clear` + 5-variant scope rubric + 24 tests. |
| P0-8 | Stop read-only ops gifting `state_hash_match` | ✅ Done | `ccb3e5798c` — Option B weights (read: 0.1/0.7/0.2, write: 0.5/0.4/0.1, mixed: 0.35/0.5/0.15). 209 tests pass. |

---

## Re-baseline gate

After P0-1, P0-2, P0-3, P0-4, P0-5, P0-6 all land, run a full multi-domain
sweep across eliza/hermes/openclaw:

```bash
python -m eliza_lifeops_bench --agent {eliza,hermes,openclaw} \
  --suite full --concurrency 2 --limit 10 \
  --output ~/.eliza/runs/lifeops/lifeops-multiagent-post-p0-$(date +%s)
```

Expected lift (from synthesis plan):
- hermes/openclaw on focus/sleep/reminders/health/finance/contacts/travel: **+0.15–0.30 mean per domain**
- eliza on mail: **0.000 → ~0.6** (from MESSAGE umbrella TS backend)
- eliza on calendar write scenarios: real state mutations, not silent no-ops
- personality `hold_style` + `note_trait_unrelated`: **+1–2 PASS per profile** (unblocks 27 scenarios)
- personality all buckets: **+10–15 verdicts move from NEEDS_REVIEW to real** (judge JSON parse)

Cost estimate (Cerebras `gpt-oss-120b`): ~$0.05/scenario × ~250 STATIC scenarios × 3 agents ≈ **$40 per full re-baseline**.

---

## Operational notes

1. **Branch churn**: `develop` is moving fast (multiple concurrent Claude sessions). Rebase + push, expect retries. Use `git pull --rebase --autostash` when the tree is clean.

2. **Stale worktree locks**: at least one stale `index.lock` exists in `/Users/shawwalters/milaidy/.git/modules/eliza/worktrees/agent-ad107607195b9d0f9/index.lock` from a prior session. Don't remove without confirming the source session is dead.

3. **Worktree isolation is partial**: agents launched with `isolation: "worktree"` write to their own working tree paths but commits land via the shared submodule `.git/modules/eliza` git dir. In practice their edits appear in the parent working tree as unstaged changes until they commit. Don't `git stash` aggressively while agents are mid-edit — the stash will swallow their in-progress work.

4. **Commit-mode mixing**: some agents commit on their `worktree-agent-XXX` branch (correct), others end up committing on `develop` directly (legacy worktree behavior). Cherry-pick from worktree branches; pull --rebase to absorb agents that pushed to develop directly.

5. **Avoid editing files an agent is working on**: `git status --short` shows what's dirty; cross-reference against the in-flight agent list before opening files.

---

## P1 — All 15 items done (2026-05-12)

| # | Item | Status | Commit |
|---|---|---|---|
| P1-1 | Auto-drop BENCHMARK_ACTION wrapper | ✅ Done | `c4056c27b4` |
| P1-2 | Forward executor errors as `last_tool_result` | ✅ Done | `c4056c27b4` |
| P1-3 | Travel passengers schema canonicalization | ✅ Done | `[w7-B]` |
| P1-4 | HEALTH discriminator alignment + scorer alias | ✅ Done | `[w7-B]` |
| P1-5 | Contact vocabulary alignment | ✅ Done | `059f3f8324` [w7-C] |
| P1-6 | Promote LIFE_* into `_tool_parameters_for_action` | ✅ Done | `0aa9727223` [w6-5] |
| P1-7 | Bench preamble for hermes/openclaw | ✅ Done | `059f3f8324` [w7-C] |
| P1-8 | Reminders manifest dedup | ✅ Done | `059f3f8324` [w7-C] |
| P1-9 | Stratified personality sampling | ✅ Done | `9c791d5e94` [w7-D] |
| P1-10 | `personality_bench` prompt branch | ✅ Done | `7a2f7943e7` [w7-D] |
| P1-11 | Surface `personality_audit_log` endpoint | ✅ Done | `[w7-E]` |
| P1-12 | `coolnessScore` rubric for escalation | ✅ Done | `[w7-E]` |
| P1-13 | Backfill probes in 12 escalation scenarios | ✅ Done | `[w7-E]` |
| P1-14 | `PersonalityStore.clear()` on reset | ✅ Done | `53e97402c0` wave-7-h6 |
| P1-15 | SCOPE_VARIANT_TO_MODE complete mapping | ✅ Done | `[w7-F]` |

## P2 — All 13 items done (2026-05-12)

| # | Item | Status | Commit |
|---|---|---|---|
| P2-1 | Tighten brittle phrase mappings | ✅ Done | `bc019a0dee` [w8-A] |
| P2-2 | `checkAllLowercase` rubric | ✅ Done | already present, verified [w8-A] |
| P2-3 | Token-cap + filler detection for `terse` | ✅ Done | `bc019a0dee` [w8-A] |
| P2-4 | HEALTH `by_metric` dedup + source priority | ✅ Done | `[w8-B]` |
| P2-5 | Sleep provider provenance field | ✅ Done | `[w8-B]` |
| P2-6 | BLOCK kwargs canonicalization + preamble hint | ✅ Done | `[w8-B]` |
| P2-7 | `list_transactions` category + date-range filters | ✅ Done | `8ddb9f354a` [w8-C] |
| P2-8 | Subscription cancel state mutation | ✅ Done | `8ddb9f354a` [w8-C] |
| P2-9 | LIFE_REVIEW / HEALTH read_with_side_effects weights | ✅ Done | `[w8-E]` |
| P2-10 | MESSAGE source-mismatch penalty | ✅ Done | `8ddb9f354a` [w8-C] |
| P2-11 | Strengthen weak rubrics (scope-isolated, trait-respected) | ✅ Done | `[w8-D]` |
| P2-12 | `len_1` shut_up threshold | ✅ Done | `[w8-D]` |
| P2-13 | Vacuous-probe carve-out | ✅ Done | `[w8-D]` |

## P3 — Implementable items done (2026-05-12)

| # | Item | Status | Commit |
|---|---|---|---|
| P3 LIFEOPS/DEVICE_INTENT aliases | ✅ Done | `dbe65b2dec` [w9-A] |
| P3 BOOK_TRAVEL.cancel codepath | ✅ Done | `dbe65b2dec` [w9-A] |
| P3 WorkoutRecord entity in LifeWorld | ✅ Done | `dbe65b2dec` [w9-A] |
| P3 EVENT_BUILD_ITINERARY_BRIEF | ✅ N/A — not referenced anywhere | |
| P3 WORK_THREAD scenarios | ✅ N/A — action is live, not orphaned | |

## Wave 10 cleanup done (2026-05-12)

Dead code, stale wave-reference comments, and `console.log` removed from bench/personality-bench files. See `[w10]` commit.

## Pending

- Post-P0+P1+P2 re-baseline run (~$40 of Cerebras calls) — see §11.1–11.3 in SYNTHESIS-IMPLEMENTATION-PLAN.md
- Cross-stack contract diff test (synthesis §11.5) — needs a separate test harness
- Duffel hotel adapter, iMessage FDA/SMS fallback, DST sleep scenarios (deferred P3 items requiring external APIs or product decisions)

---

## Reference commits (this session)

- `62ebaac31a` Phase 8 — cerebras-nightly workflow + delta reporter
- `677a54bfca` P0-2 — personality bridge keys
- `b82b302ccc` P-voice-1 — vendor VoiceBench (quality, separate from latency)
- `661107e6a5` P0-3 — judge JSON parse + tolerant parser (pre-session)
- `76add4ddd8` Phase 1 — holdout-split + promotion gate (pre-session)
- `587fa85b41` Phase 5 — registry split into registry/ package
