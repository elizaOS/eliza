# LifeOps pipeline — operator runbook (2026-05-11)

What's left after the rebuild that the **operator** (not Claude) must do.
Each item lists the command, prerequisites, expected runtime, and what to
do with the output.

Cross-links: [`REPORT.md`](./REPORT.md) (canonical summary),
[`INDEX.md`](./INDEX.md) (per-wave deliverables),
[`wave-5a-gap-list.md`](./wave-5a-gap-list.md) (gap inventory).

---

## 1. First measured retrieval-funnel run (gap-list P3#1)

**Why**: `retrieval-funnel.{md,json}` is structurally correct but reports
`counted samples: 0` because no full run has yet emitted measurement
trajectories. The per-tier defaults in
`packages/benchmarks/lib/src/retrieval-defaults.ts` are heuristic until
real measurements land.

**Prereq**: `CEREBRAS_API_KEY` in `.env`.

**Command**:
```bash
cd /Users/shawwalters/milaidy/eliza
ELIZA_RETRIEVAL_MEASUREMENT=1 bun run lifeops:multi-tier:core
bun run lifeops:retrieval:funnel
bun run lifeops:retrieval:pareto
```

**Estimated runtime**: 30–90 min (Cerebras throughput dependent).

**Action after**: review `retrieval-funnel.md` and `retrieval-pareto.md`.
Either update the constants in `retrieval-defaults.ts` with measured
top-K + stage weights, or document the measured deltas if the heuristics
held up.

---

## 2. Anthropic re-bench with DSPy-optimized planner (P3#2)

**Why**: the current rebaseline is Cerebras-only because `ANTHROPIC_API_KEY`
was unset at W2-9 time.

**Prereq**: `ANTHROPIC_API_KEY` in `.env`.

**Command**:
```bash
bun run lifeops:multi-tier:smoke --tiers frontier
# After it completes, diff vs the Cerebras baseline:
bun run lifeops:delta -- \
  --baseline runs/<cerebras-runId> \
  --candidate runs/<anthropic-runId> \
  --out runs/anthropic-vs-cerebras
```

**Estimated runtime**: 10–20 min (Anthropic Opus 4.7).

**Action after**: confirm pass-rate and cost deltas; if Anthropic regresses
materially on a scenario the planner improved on Cerebras, that's a sign
the DSPy-optimized planner over-fit to the Cerebras teacher.

---

## 3. Run other lifeops domains (P3#3)

**Why**: the W2-9 rebaseline is calendar-only (25/25 scenarios). The full
suite has 100+ scenarios across mail, reminders, contacts, finance,
travel, health, sleep, etc. Per-domain numbers diverge significantly —
hermes peaked at 0.494 on `mail` in W1-3 while `calendar` is much harder.

**Prereq**: `CEREBRAS_API_KEY`.

**Command**:
```bash
# Single domain
python -m eliza_lifeops_bench --agent hermes --suite core --domain mail
python -m eliza_lifeops_bench --agent hermes --suite core --domain reminders
python -m eliza_lifeops_bench --agent hermes --suite core --domain contacts
python -m eliza_lifeops_bench --agent hermes --suite core --domain finance
python -m eliza_lifeops_bench --agent hermes --suite core --domain travel
python -m eliza_lifeops_bench --agent hermes --suite core --domain health
python -m eliza_lifeops_bench --agent hermes --suite core --domain sleep

# Or the full core suite in one shot:
bun run lifeops:multi-tier:core
```

**Estimated runtime**: ~5–10 min per domain × 7 domains = 35–70 min.

**Action after**: update `rebaseline-report.md` with per-domain numbers.
Anything < 0.30 pass-rate is a candidate for targeted scenario-level
investigation.

---

## 4. Plumb hermes per-turn cost+latency (P3#4 / F4)

**Status**: in progress under Wave 6-F4 (`wave-6-f4` commit). After it
lands, confirm with:
```bash
cd packages/benchmarks/lifeops-bench && python -m pytest tests/test_unified_telemetry.py -v
```

---

## 5. smoke_static_calendar_01 "scheduled, deep work" re-baseline (P3#5)

**Why**: this scenario's required-output substring + W4-D's `BLOCK`
simile fix should now unblock it, but the rebaseline didn't include a
specific re-run.

**Command**:
```bash
python -m eliza_lifeops_bench \
  --agent hermes \
  --scenario smoke_static_calendar_01 \
  --seeds 5
```

**Estimated runtime**: 1–2 min.

**Action after**: if it still fails, dump the agent transcript and check
whether the substring match is too strict (look at `scorer.py`'s
substring-match logic).

---

## 6. eliza-1-* bundle `final` flips (P3#6)

**Why**: all 5 eliza-1 bundles are currently `releaseState=local-standin`,
`publishEligible=false`, `final.weights=false`. The aggregator stamps a
PRE-RELEASE banner on every report that uses them. To remove the banner,
each bundle must clear its per-bundle checklist.

**Per-bundle checklist** — see [`eliza-1-status.md`](./eliza-1-status.md).
Per bundle, the operator must:
- Ship final weights (not local-standin).
- Validate `sha256`.
- Set `releaseState: "final"` in the bundle `manifest.json`.
- Flip `publishEligible: true` and `final.weights: true`.

**Verification per bundle**:
```bash
bun -e "import('@elizaos-benchmarks/lib').then(m =>
  m.readElizaOneBundle('~/.eliza/local-inference/models/eliza-1-0.6b.bundle')
    .then(b => console.log({bundleId: b.bundleId, preRelease: m.bundleIsPreRelease(b)})))"
```

**Owner**: eliza-1 inference team.

---

## 7. DFlash drafters for 0.6B and 1.7B (P2#2)

**Why**: per [`eliza-1-status.md`](./eliza-1-status.md), the dflash
server falls back to base weights for the 0.6B and 1.7B bundles —
loses speculative decoding throughput.

**Owner**: eliza-1 inference team. Track in
[`eliza-1-status.md`](./eliza-1-status.md) per bundle.

---

## 8. Personality model-level gaps (P2#5)

**Why**: two scenarios fail across all agents:
- `hold_style.aggressive.code.004`
- `escalation.aggressive.code.004`

Per [`rebaseline-report.md`](./rebaseline-report.md), this is a Cerebras
gpt-oss-120b instruction-following limitation under aggressive register.
Not a harness bug.

**Action**: document as a known model limitation. Revisit on next model
upgrade (e.g. when gpt-oss-180b ships, or when the Cerebras-served
fine-tune of gpt-oss arrives).

---

## Verification commands after every runbook item

```bash
bun run test:cache-stability
bun test packages/benchmarks/lib/src/__tests__/
bun test plugins/app-training/src/dspy/__tests__/
cd packages/benchmarks/lifeops-bench && python -m pytest tests/ -q
```

All must remain green. If anything regresses, fix before continuing.

---

## Final close-out checklist

- [x] All P1 items committed (`wave-6-f1` manifest + validator,
  `wave-6-f2` DSPy count reconcile).
- [x] All addressable P2 items committed (`wave-6-f3` Cerebras endpoint).
- [x] All addressable P3 items committed (`wave-6-f4` per-turn cost).
- [x] Runbook published (this file, `wave-6-f5`).
- [ ] Runbook items 1–3, 5, 6, 7, 8 acknowledged + scheduled by operator.
- [ ] `git push origin develop` once operator approves.
