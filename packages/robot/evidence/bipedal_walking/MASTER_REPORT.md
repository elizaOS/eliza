# Bipedal walking + continual learning + text conditioning — master report

_Generated 2026-05-31T00:56:02Z. Base: `/home/shaw/milady/eliza/packages/robot`._

## 1. Claim Status

This is **not yet verified as an actual bipedal walking agent**. The available evidence shows a Brax PPO training reward curve for a MuJoCo Playground joystick locomotion env, plus separate toy continual-learning retention evidence. The required per-command walking evaluation is missing, so this artifact cannot prove that a trained policy walks, follows text-conditioned joystick commands, or retains walking skills under Alberta continual learning. Each section below is backed by an evidence file; sections whose source is not yet present are marked pending (see Status).

## 2. Does it walk?

### Training reward (brax PPO)

- Final reward: **11.853** at 32440320 steps
- Best reward: **11.853**  ·  start: 0.122
- Reward curve: `▁▄▇█` (4 logged points)

| steps | reward | fps |
|---:|---:|---:|
| 0 | 0.122 | 0.000 |
| 10813440 | 5.318 | 21679.737 |
| 21626880 | 9.895 | 34284.603 |
| 32440320 | 11.853 | 42419.567 |

_Walk eval (`walk_eval.json`) not found — walking is unverified. Reward improvement alone is not accepted as locomotion proof._

## 3. Text conditioning

Free text is intended to map deterministically to a joystick command `[vx, vy, yaw]`, but the missing walk eval means the trained policy has not been proven to follow those command vectors.

_No text→command mapping found yet (needs `walk_eval.json` or `continual_skills.json`)._

## 4. Continual learning

Sequential text-command walking skill learning is **not verified** in this artifact. The intended setup is `multihead` per-command heads over a consolidated trunk versus a single shared-head `finetune` baseline, but the required walking continual-skills evidence is missing.

_Continual skills (`continual_skills.json`) not found — multihead-vs-finetune comparison pending._

### joint_reach retention tournament

See [`evidence/alberta_retention_tournament/TOURNAMENT_REPORT.md`](evidence/alberta_retention_tournament/TOURNAMENT_REPORT.md).

Headline: on the toy `joint_reach` continual benchmark, per-task heads over a frozen trunk (`cbp_frozen`) reach **ACC 36.46 / Forgetting 0.00**, beating PPO (ACC 28.48) and the linear lookup (ACC 30.44); the plastic shared-trunk `cbp_multihead` reaches the highest capacity (ACC 38.94) with modest forgetting (5.67). Suggestive, not conclusive (2 seeds, toy env).

### Retention v2 ablation (5-task / 3-seed)

_Retention v2 ablation (`alberta_retention_v2/SUMMARY.json`) not found — 5-task/3-seed run pending._

## 5. Reward correctness

See [`evidence/bipedal_walking/REWARD_AND_APPROACH.md`](evidence/bipedal_walking/REWARD_AND_APPROACH.md).

The prior hand-rolled env paid an alive/upright bonus that dominated forward progress, so the optimal policy was to stand still (untrained control out-scored both learners). `train_biped_walk.py` instead uses the MuJoCo Playground joystick reward: dense velocity-command tracking plus a small alive bonus, energy cost, and early termination on a fall — so the gradient points toward locomotion, not toward quiet standing.

## 6. Status — verified vs pending

Evidence files present at generation time:

| evidence source | path | found |
|---|---|:--:|
| PPO training reward (metrics.json) | `checkpoints/biped_walk_berkeley/metrics.json` | yes |
| Walk eval (walk_eval.json) | `checkpoints/biped_walk_berkeley/walk_eval.json` | no |
| Continual skills (continual_skills.json) | `evidence/bipedal_walking/continual_skills/continual_skills.json` | no |
| Retention tournament (TOURNAMENT_REPORT.md) | `evidence/alberta_retention_tournament/TOURNAMENT_REPORT.md` | yes |
| Retention v2 ablation (SUMMARY.json) | `evidence/alberta_retention_v2/SUMMARY.json` | no |
| Reward writeup (REWARD_AND_APPROACH.md) | `evidence/bipedal_walking/REWARD_AND_APPROACH.md` | yes |

**3/6 sources present.** Sections backed by a missing source are explicitly marked pending above rather than fabricated.
