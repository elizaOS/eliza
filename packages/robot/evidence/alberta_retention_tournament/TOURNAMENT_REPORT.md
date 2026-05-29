# Alberta continual-learning retention tournament

**Question.** Continual Backprop preserves *plasticity*, not *memory* — a shared MLP
trained on a task sequence still forgets ([cbp_none] below). Can a nonlinear
MLP controller match the linear `sparse_gated` controller's near-zero forgetting
**while having more capacity** (learning each task better), and beat PPO?

**Setup.** `joint_reach`, 4 tasks trained sequentially, 6000 env-steps/task,
2 seeds (1000, 1001), 8 eval episodes. After every phase all learners are
evaluated on all tasks → task×phase matrix → ACC/BWT/Forgetting (Lopez-Paz &
Ranzato 2017). Every run shares the same env, seeds, protocol, and budget; PPO
appears in every run as a **determinism anchor**.

**Verification.** All metrics below were *independently recomputed from the raw
task×phase matrices by adversarial verifier agents* and match the harness to
machine precision. PPO's recomputed ACC = **28.4814** in all five runs (max
pairwise Δ = 0.000000), confirming the harness is deterministic and the runs are
directly comparable.

## Results

| variant | mechanism | ACC ↑ | BWT ↑ | Forgetting ↓ | capacity (mean-diagonal) ↑ | retained (final) |
|---|---|---:|---:|---:|---:|---:|
| `linear` | linear, frozen `sparse_gated` lookup | 30.44 | 0.00 | 0.00 | 30.44 | 30.44 |
| `ppo` | shared MLP (SB3, warm-started) | 28.48 | −1.59 | 3.74 | — | 28.48 |
| `cbp_none` | MLP + CBP, **single shared head** | 23.86 | −12.22 | 14.83 | 33.02 | 23.86 |
| **`cbp_frozen`** | MLP, **frozen** random trunk + per-task heads (CBP off) | **36.46** | **0.00** | **0.00** | 36.46 | 36.46 |
| `cbp_warmupfrz` | MLP, plastic trunk → **consolidated** after task 0 + per-task heads | 35.71 | 0.00 | 0.00 | 40.80 | 35.71 |
| `cbp_multihead` | MLP, **plastic** trunk + per-task heads + CBP | **38.94** | −4.56 | 5.67 | **42.36** | 38.94 |

"capacity (mean-diagonal)" = mean over tasks of the eval return on each task *the
moment it finished training* — how well the learner can fit a task at all.
"retained (final)" = mean eval return at the end of the whole stream.

## Findings

1. **Nonlinear capacity beats the linear lookup.** Every MLP variant fits each
   task better than the linear `sparse_gated` lookup (mean-diagonal 33–42 vs
   **30.44**). This is the capacity the linear controller lacked — and the reason
   it could never represent a walking gait.

2. **The retention mechanism is necessary.** Turn it off (`cbp_none`, single
   shared head) and the MLP catastrophically forgets: mean-diagonal 33.02
   collapses to a final 23.86 (Forgetting **14.83**), losing to PPO on every axis.

3. **`cbp_frozen` wins retention+capacity.** Per-task heads over a frozen random
   trunk give **0 forgetting and ACC 36.46** — it strictly dominates the linear
   lookup (same perfect retention, **+6 ACC / capacity**) and beats PPO (+8 ACC).
   *Honest caveat (raised by the adversarial verifiers):* this zero forgetting is
   **zero-by-construction** — a frozen trunk + isolated per-task heads make
   off-diagonal degradation mathematically impossible (R[T-1][j] == R[j][j]). It
   demonstrates zero-interference *isolation*, not learned robustness in a shared
   representation. It is the right default when tasks are known and routable; it
   is not evidence of solving forgetting in a shared net.

4. **`cbp_multihead` is the genuine shared-representation result.** With a plastic
   shared trunk it reaches the **highest ACC (38.94) and capacity (42.36)** and
   beats PPO on ACC, while keeping Forgetting (**5.67**) comparable to PPO's
   (3.74) — real interference returns the moment the trunk is allowed to change.
   This is the honest "learn well *and* mostly retain in a shared net" point.

5. **`cbp_warmupfrz` is the sweet spot when a task boundary is known.** Letting
   the trunk learn during task 0 and then consolidating gives **0 forgetting**
   *and* higher capacity than frozen (mean-diagonal 40.80 vs 36.46) — it learns
   good shared features first, then protects them. Requires knowing when to
   consolidate (here, after the first task's budget).

6. **Two mechanism interactions were found and fixed:**
   - The **EMA observation normalizer is a shared global statistic** that drifts
     toward the current task and corrupts earlier tasks' inputs — a silent
     continual-learning leak. The benchmark cbp config disables it (the env obs
     are already well-scaled), matching the linear controller.
   - **CBP generate-and-test conflicts with a frozen/consolidated trunk**:
     replacing a shared hidden unit zeros a head column across *all* task slots,
     damaging past tasks' frozen readouts. CBP is therefore disabled once the
     trunk is frozen/consolidated (`cbp_frozen`, and `cbp_warmupfrz` after
     consolidation). CBP stays on only for the fully-plastic `cbp_multihead`,
     where its job (plasticity preservation over a long stream) is actually
     needed.

## Recommendation

- **Default continual robot controller: `cbp_frozen`** (or `cbp_warmupfrz` when a
  consolidation point is available) — perfect retention with more capacity than
  the linear lookup, and beats PPO.
- **When the stream needs ongoing plasticity for genuinely novel tasks:**
  `cbp_multihead`, accepting modest forgetting for the highest capacity.

## Caveats

Only 2 seeds and a toy `joint_reach` (damped double-integrator) env — the
headline means are noisy and this is **suggestive, not conclusive**. The frozen
variants' zero forgetting is by-construction (per-task isolation). The real test
is transferring these mechanisms to a capable locomotion policy on a properly
shaped walking reward (the next step).

## Reproduce

```bash
cd packages/robot
JAX_PLATFORMS=cpu .venv/bin/python -m eliza_robot.rl.alberta.benchmark \
  --env joint_reach --n-tasks 4 --n-joints 4 --steps-per-task 6000 --seeds 2 \
  --learners alberta_cbp ppo --cbp-retention-mode frozen \
  --cbp-hidden-sizes 128 --cbp-n-slots 64 --out-dir evidence/alberta_retention_tournament/cbp_frozen
# variants: --cbp-retention-mode {none,multihead,frozen,warmupfreeze}; linear ref: --learners alberta ppo
```
