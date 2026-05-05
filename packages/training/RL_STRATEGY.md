# Reinforcement Learning Strategy for the eliza-1 Series

**Status:** design doc, scope = post-SFT RL on the eliza-1 model series
(`eliza-1-2b`, `eliza-1-9b`, `eliza-1-27b`).

**Goal:** define the smallest reasonable RL pipeline that takes a fresh
SFT checkpoint from APOLLO and produces a measurably-better RL release
on the same HF repo with a `-rl-v1` suffix (`elizaos/eliza-1-2b-rl-v1`,
etc.) using the trajectory infrastructure that is already in this
codebase.

This is intentionally not a survey of every RL algorithm — it's a
recommended-path doc with the rationale spelled out so we can defend
the choice if it doesn't work.

---

## TL;DR

| stage | method | data | library | hardware | output |
|-------|--------|------|---------|----------|--------|
| 0     | SFT (current) | `elizaos/eliza-toon-v1-sft` | APOLLO (in-tree) | 1× H200 (9B) / 2× H200 (27B) | `elizaos/eliza-1-{2b,9b,27b}` |
| 1     | DPO    | best-vs-worst pairs from trajectory groups | TRL `DPOTrainer` | same as SFT | `elizaos/eliza-1-{2b,9b,27b}-dpo-v1` |
| 2     | GRPO (RLVR) | trajectory groups + verifiable reward (`eliza_bench` correctness + AI-judge) | **verl** | 4× H200 (2b/9b) / 8× H200 (27b) | `elizaos/eliza-1-{2b,9b,27b}-rl-v1` |

Stage 1 is the cheap warmup that proves the data pipeline produces
useful preference pairs. Stage 2 is the actual leverage — GRPO with a
verifiable reward signal is the algorithm DeepSeek used to push R1 past
GPT-4 on math, and our `eliza_bench` format/content correctness is a
clean verifiable signal for the agentic TOON outputs.

---

## What we already have

The trajectory + reward infrastructure was built for trading agents but
generalizes cleanly. Concrete artifacts (read these before changing the
plan):

- `eliza/packages/core/src/features/trajectories/types.ts` — the
  `Trajectory` shape: full step list, per-step reward, environment
  state, LLM calls, action attempts, and a `RewardComponents` object
  with `environmentReward`, `aiJudgeReward`, `judgeModel`,
  `judgeReasoning`, plus arbitrary domain components (`profitLoss`,
  `predictionAccuracy`, `socialEngagement`, `riskAdjusted`, …).
- `eliza/packages/core/src/features/trajectories/reward-service.ts` —
  the heuristic scorer. Returns normalized rewards in `[-1, 1]`, and
  `scoreTrajectoryGroup` already does **min-max normalization across a
  group**, which is exactly the operation GRPO performs on a sampled
  group of completions per prompt. We can plug this scorer straight
  into the reward function.
- `eliza/packages/core/src/features/trajectories/art-format.ts` —
  `toARTJSONL` + `groupTrajectories` produce ART-format JSONL keyed by
  `scenarioId` / `comparisonGroup`. ART format is "message arrays +
  per-trajectory reward + group key", which is identical to what TRL's
  `DPOTrainer` and verl's GRPO trainer expect after a thin adapter.
- `eliza/apps/app-training/src/backends/{atropos,tinker,native}.ts` —
  three training-backend hooks already exist. The `atropos` and
  `tinker` ones are stubs that stage data and shell out; `native` is
  the in-tree DSPy/MIPRO path for prompt optimization. RL belongs in a
  new `verl` (or `trl`) backend alongside these.
- `eliza/apps/app-training/src/core/trajectory-export-cron.ts` —
  nightly cron pulls trajectories, runs the privacy filter, and writes
  bucketed JSONL files under
  `<state>/training/datasets/<YYYY-MM-DD>/`. **Privacy filter is
  mandatory on every export path** (see CLAUDE.md). Whatever RL
  pipeline we build consumes those JSONL files — we never re-touch raw
  trajectories.
- `training/scripts/benchmark/eliza_bench.py` — verifiable scorer for
  TOON output: format correctness (parseable + required fields
  present) and content correctness (action-name match for the
  planner, RESPOND/IGNORE match for routing, text presence for
  replies). This is the **reward function for stage 2**.

Two things we don't have:

1. A **reward model**. We use heuristic + verifiable rewards instead,
   which side-steps the "reward hacking via overfit RM" failure mode
   that plagues RLHF. If we ever need preference learning at scale,
   train an RM on the AI-judge labels we already log in
   `RewardComponents.judgeReasoning`.
2. A **rollout server**. For GRPO we need to sample N completions per
   prompt at training time. verl bundles this; TRL's GRPO needs a
   separate vLLM rollout server pointed at the policy. See
   "Hardware + cost" below.

---

## Algorithm choice (and why GRPO, not PPO or DPO-only)

| algo | needs RM | needs rollouts | needs paired data | best at | weakness |
|------|---------|----------------|-------------------|---------|----------|
| **SFT** | no | no | no | shaping format/style from labeled data | doesn't fix off-policy errors |
| **DPO** | no | no | **yes** (chosen/rejected pairs) | quick preference alignment | requires upfront pair construction; can over-fit if pairs are noisy |
| **KTO** | no | no | no (single example + thumbs up/down) | when only binary feedback exists | weaker signal than DPO/GRPO |
| **RLOO** | no | yes (group of K) | no | small models, cheap | weaker than GRPO at depth |
| **GRPO** | no | yes (group of K) | no | reasoning, verifiable rewards | needs group-of-K rollouts → expensive |
| **PPO**  | yes | yes | no | full RLHF stack | needs RM + value head; reward hacking |

**For our case GRPO is the right primary algorithm:**

- We have **verifiable rewards** (eliza_bench), so we don't need a
  learned RM and don't pay the reward-hacking tax that PPO does.
- The output space (TOON-formatted action plans, routing decisions,
  reply text) has **clear correctness criteria** that a heuristic
  scorer can compute in milliseconds. That makes group-of-K rollouts
  cheap to score, which is GRPO's main cost.
- DPO can't capture reward gradients across a group of completions —
  it can only rank pairs. GRPO uses the full group's reward
  distribution, which is strictly more information.
- We've already implemented "score a group of trajectories with min-max
  normalization" in `reward-service.ts`. That's literally one of the
  three operations GRPO does.

**DPO is the right warmup** because it doesn't need a rollout server.
We can run it on already-collected trajectories: pair the highest-reward
trajectory in each `comparisonGroup` against the lowest, train DPO,
measure on `eliza_bench`. If DPO+SFT doesn't beat SFT-alone, the data
pipeline is broken and we should fix that before paying for GRPO
rollouts.

---

## Reward signal design

A reward function for the eliza-1 series, by precedence (highest wins):

1. **Verifiable correctness** (`eliza_bench`):
   - Format: TOON parses + required schema fields present → +1 / 0.
   - Content: ground-truth action name match (planner) / RESPOND-IGNORE
     match (routing) / non-empty text (reply) → +1 / 0.
   - This is **deterministic, cheap, and reward-hack-resistant** —
     gaming the format check is the same as producing correct format,
     which is what we want.

2. **Heuristic per-trajectory** (`reward-service.ts`):
   - P&L (weight 0.4) — only for trading-agent trajectories.
   - Success rate (weight 0.3) — task completion fraction.
   - Completion (weight 0.2) — `finalStatus == "completed"`.
   - Environment reward (weight 0.1) — domain-specific signal.

3. **AI-judge** (`RewardComponents.aiJudgeReward`):
   - Pairwise judgment by a stronger model (Claude / GPT-5) over a
     held-out trajectory. Used for fine-grained preference ranking when
     verifiable + heuristic agree but we want stylistic discrimination.
   - **Cap weight at 0.2 of the total** — judge models drift, and
     leaning on judge labels is how you reward-hack into sycophancy.

The scalar reward fed to GRPO is:

```
r = clamp(
    1.0 * verifiable_correctness     # primary signal
  + 0.5 * heuristic_per_trajectory   # secondary (already in [-1,1])
  + 0.2 * ai_judge_reward            # tertiary, capped
  , -1, 1)
```

Per-step rewards (`step.reward` in the schema) flow into GRPO as the
group-relative advantage at each step; we don't replace them with the
trajectory-level scalar.

---

## Library choice: verl > TRL > OpenRLHF

The three credible options for stages 1-2:

### TRL (Hugging Face)

- **Pros:** mature, well-documented, integrates with `accelerate` and
  FSDP. `DPOTrainer`, `KTOTrainer`, and `GRPOTrainer` are all v0.18+
  surface. Fits the existing APOLLO+Liger+FSDP stack.
- **Cons:** GRPO needs a separately-managed vLLM rollout server;
  scaling beyond 8× H200 is awkward. Long-context (>32k) GRPO is
  fragile.
- **Use it for stage 1 (DPO)** because no rollout server is required
  and it slots into the current Nebius pipeline with minimal new infra.

### verl (ByteDance Seed)

- **Pros:** purpose-built for RLVR, used to train DeepSeek-style
  reasoning models. Bundles vLLM/SGLang for rollouts, FSDP+Megatron for
  training, supports verifiable rewards as first-class. Best support
  for long-context GRPO (this matters for 27B at 32k+ context).
- **Cons:** newer (Apache-2.0 since 2024), more setup, opinionated
  configuration (Hydra YAML).
- **Use it for stage 2 (GRPO)** because the rollout-server
  orchestration is the part TRL gets wrong at this scale, and verl
  bundles it.

### OpenRLHF (OpenLLMAI)

- **Pros:** Ray-based, scales out to multi-node cleanly, PPO/GRPO/DPO.
- **Cons:** harder ramp, optimized for >100B models. Overkill at our
  sizes — stage 2 fits on a single node.
- **Skip** unless we go past 70B.

### Atropos (already in-tree)

- Currently a stub backend that stages data and shells out to an
  external `atropos` binary. Keep the backend in place for future
  integration but don't bet stage 1-2 on it — there's no in-repo SDK
  and the upstream engine is opinionated about data shape.

### Tinker (Thinking Machines)

- Hosted SFT/RLHF API. Good if we want to outsource the GPU bill, but
  the cost-per-run is ~3-5× a self-hosted Nebius equivalent and the
  pipeline is closed-source. **Skip for the eliza-1 launch.**

---

## Hardware + cost

Per-stage GPU budget for one full RL run on a single eliza-1 size:

| stage | 2b | 9b | 27b | per-run wall-clock | per-run cost (Nebius H200 SXM @ ~$2.50/hr) |
|-------|----|----|-----|--------------------|--------------------------------------------|
| 1 (DPO) | 1× H200 | 1× H200 | 2× H200 (FSDP) | ~6h on data we already have | $15 / $15 / $30 |
| 2 (GRPO, K=8 rollouts) | 2× H200 (1 train + 1 rollout) | 4× H200 (1 train + 3 rollout shards) | 8× H200 (4 train + 4 rollout) | ~24-48h depending on dataset size | $120 / $240 / $960 |

For the 27B at stage 2, we're at the edge of one Nebius node. If the
rollout server is sharded onto 4 separate H200s and the policy trains
under FSDP on the other 4, we stay on a single 8× node. Going to 4× +
4× across two nodes is a Day-2 problem.

**Sequencing recommendation:** run the 2B all the way through stages
0→1→2 first, end-to-end, on real trajectory data. That validates the
pipeline end-to-end at $135 per iteration. Once 2B is producing
visible improvements on `eliza_bench`, scale to 9B and 27B.

---

## Concrete next steps

1. **Stage 0 (SFT)** — already wired. Run on `elizaos/eliza-toon-v1-sft`
   per the existing `train_nebius.sh` flow, push to
   `elizaos/eliza-1-{2b,9b,27b}` via the new
   `scripts/push_model_to_hf.py`. **No new code needed.**

2. **Stage 1 (DPO)** —
   - Add `training/scripts/build_dpo_pairs.py`: read the JSONL exports
     from `<state>/training/datasets/<date>/`, group by
     `scenarioId`/`comparisonGroup`, write
     `data/final/dpo/{train,val}.jsonl` with `{prompt, chosen, rejected}`
     keys (TRL's expected schema) where `chosen`/`rejected` are the
     highest-reward / lowest-reward trajectory in each group's message
     array.
   - Add `training/scripts/train_dpo.py`: thin wrapper around
     `trl.DPOTrainer` keyed on `--registry-key`; reuses
     `model_registry.REGISTRY[<key>]` for hyperparams.
   - Land at `elizaos/eliza-1-<size>-dpo-v1` via
     `push_model_to_hf.py --repo-id elizaos/eliza-1-<size>-dpo-v1
     --checkpoint <dpo-out>`. (DPO is not a quantization variant, so it
     uses the bf16 base path; the `-dpo-v1` repo-id distinguishes the
     lineage.)
   - **Success criterion:** DPO checkpoint beats SFT on `eliza_bench`
     by ≥3 pp on at least two of the three buckets (planner / routing
     / reply).

3. **Stage 2 (GRPO with verl)** —
   - Add `training/scripts/train_grpo_verl.sh`: provisions a Nebius
     8-GPU node, syncs verl + the trajectory data, runs
     `python3 -m verl.trainer.main_ppo +trainer.algorithm=grpo` with a
     reward function that calls into `eliza_bench` for correctness +
     `reward-service.ts` (port to Python or shell out via the
     loopback API the runtime already exposes).
   - Add `training/scripts/eliza_reward_fn.py`: the verifiable-reward
     callable verl invokes per rollout. Inputs the model's TOON
     output + ground-truth from the prompt's `metadata`, returns
     `{"reward": float, "components": {...}}` so verl's logger
     captures the breakdown.
   - Land at `elizaos/eliza-1-<size>-rl-v1`.
   - **Success criterion:** RL checkpoint beats DPO checkpoint by
     ≥5 pp on at least one bucket without regressing the others.

4. **Online learning loop (later)** —
   - When the runtime emits a trajectory with a verifiable score, the
     trajectory-export cron promotes it to the RL training pool.
     Re-run stage 2 weekly on the accumulated delta (rolling-window
     RLHF). Land each iteration as
     `elizaos/eliza-1-<size>-rl-v<n>`.

---

## What we explicitly are NOT doing

- **Reward modeling** (training an RM from preference data). The
  AI-judge labels we log are diagnostic only — we don't fit an RM on
  them, because verifiable rewards are stronger and reward hacking is
  the single largest failure mode in real RLHF runs.
- **PPO with a learned RM.** Same reason. PPO is well-supported in
  TRL/OpenRLHF/verl but requires building infra we don't need given
  GRPO+RLVR is on-target.
- **Rollouts without a verifier.** Every GRPO step requires a reward
  signal we trust. If `eliza_bench` doesn't cover a task, we add
  coverage there *before* training that task with RL.
- **Cross-entropy distillation from a stronger model.** Belongs in
  SFT, not RL.

---

## References

- DeepSeek-R1 / DeepSeekMath GRPO: https://arxiv.org/abs/2402.03300
- verl: https://github.com/volcengine/verl
- TRL DPO/GRPO: https://huggingface.co/docs/trl
- OpenRLHF: https://github.com/OpenRLHF/OpenRLHF
- APOLLO (the SFT optimizer we already use): https://arxiv.org/abs/2412.05270
