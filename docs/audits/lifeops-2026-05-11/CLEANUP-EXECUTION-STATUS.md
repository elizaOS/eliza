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
| 2 | Consolidate 4 Cerebras judge wrappers | 🟡 Planned | Hold for end-of-session — touches files multiple agents have edited. |
| 3 | Adapter parity + transport dedup | ✅ Done | `BaseBenchmarkClient` extracted to `packages/benchmarks/lib/`. All three adapters subclass + override `_send`. **Eliza $0 cost bug fixed** (server.ts propagates `usage` to HTTP response). 164 tests pass. Commit `6e1d8b200d`. |
| 4 | Voice benchmarks (VoiceBench, MMAU, VoiceAgentBench) | 🟡 2 of 3 done | **VoiceBench** at `b82b302ccc` (`voicebench-quality/`, 25 tests). **MMAU** at `dc24e51b4c` (`packages/benchmarks/mmau/`, 53 tests). **VoiceAgentBench** still in flight (agent `a58604a002051bfe7`). |
| 5 | Registry split + stub purge | ⛔ Blocked | Wait for VoiceAgentBench to land its registry entry. Then split `registry.py` (now ~44 entries) by domain. |
| 6 | Python ↔ TS training bridge | ✅ Done | `local_path` source type, `eval_checkpoint.py` writes to W0-X5 store, `eliza-nightly-*` dataset entries. 18 new tests + 30 results-store regression tests pass. Commit `ae912c3450`. |
| 7 | Formal GEPA (Goyal et al. 2024) | 🟡 In flight | Agent `a17413e1e37cf24b0`. `runGepa` imported in `native.ts` dispatcher. Pending commit. |
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
| P0-6 | Inline LIFE_CREATE wire shape into `_TOOL_DESCRIPTIONS` | 🟡 In flight | Agent `aaeae1fd70b8363d0`. |
| P0-7 | Bench-server role seeding for `scope_global_vs_user` | ⛔ Not started | Holding — needs design pass on runner cooperation. After P0 batch lands. |
| P0-8 | Stop read-only ops gifting `state_hash_match` | ⛔ Not started | Holding — coordinate with P0-1 measurement so the lift attribution is clean. |

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

## Pending (post-current-session)

- Phase 2 judge consolidation (single `CerebrasJudge` class, four callers migrate)
- Phase 5 registry split (after Phase 4 agents land their entries)
- P0-7 + P0-8 (need design sync before implementation)
- P1 batch (15 items per synthesis plan)
- Cross-stack contract diff test (synthesis §11.5)
- Stratified personality sampling (§11.2)
- Post-P0 re-baseline run (~$40 of Cerebras calls)

---

## Reference commits (this session)

- `62ebaac31a` Phase 8 — cerebras-nightly workflow + delta reporter
- `677a54bfca` P0-2 — personality bridge keys
- `b82b302ccc` P-voice-1 — vendor VoiceBench (quality, separate from latency)
- `661107e6a5` P0-3 — judge JSON parse + tolerant parser (pre-session)
- `76add4ddd8` Phase 1 — holdout-split + promotion gate (pre-session)

All others (P0-1, P0-4, P0-5, P0-6, MMAU, VoiceAgentBench, GEPA, Phase 3, Phase 6) on their respective `worktree-agent-*` branches, pending cherry-pick when their working-tree edits clear.
