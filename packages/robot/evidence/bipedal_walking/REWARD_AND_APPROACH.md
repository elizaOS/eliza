# Bipedal walking + continual learning: reward design and integrated approach

This document explains why the prior robot-learning setup failed to produce
walking, what reward actually makes walking learnable, and how the three pieces
(PPO walking representation, text conditioning, Alberta continual learning) fit
together. Numbers are quoted directly from the evidence files in this tree.

## 1. The reward pathology that was found

The prior `TextConditionedProfileEnv` training did not just fail to improve a
policy — it produced policies *worse than doing nothing*. In the Nebius full run
(`robot-full-clean-1779556360`, `nebius_full_training/synced_run/training_comparison_report.md`):

- **Untrained policy mean reward: `251.5050`**
- **PPO mean reward: `194.8435`** (delta vs untrained `-56.6615`)
- **Alberta mean reward: `165.8210`** (delta vs untrained `-85.6840`)

Both learners moved *down* the reward axis relative to the untrained control.
The downstream physical checks agree that nothing learned to walk:

- Every profile failed walk feasibility (`multi_profile_walk_feasibility.md`):
  **valid walking profiles `0`**, passive-success profiles `0`, across
  `hiwonder-ainex`, `unitree-g1`, `unitree-h1`, `unitree-r1`, `asimov-1`.
- Learned-policy curriculum eval pass rate was **`0.0` (0/7)** —
  `stand_up`, `walk_forward`, `walk_backward`, `sidestep_left/right`,
  `turn_left/right` all at `0.00` success (`robot_motion_learning_audit.md`).

The root cause is the reward shape. The alive/upright bonus dominated forward
progress, so the optimizer's best move was to *stand still* (or barely shuffle)
to keep collecting the survival bonus. That is exactly why a policy that does
nothing scored highest (`251.5`): the reward effectively paid the robot to not
fall rather than to go anywhere. Open-loop and short-probe searches confirm the
symptom from the other side — the best local probe verdict was
`stable_forward_shuffle_below_distance` and gait searches found
**0 forward + no-fall + straight candidates** out of hundreds tried.

## 2. The correct locomotion reward

`scripts/train_biped_walk.py` does not hand-roll a reward. It loads the
**MuJoCo Playground joystick locomotion envs** (`mujoco_playground.registry`,
e.g. `BerkeleyHumanoidJoystickFlatTerrain`) with their sim2real-proven reward,
which combines:

- **velocity-command tracking** — the dense term: track the commanded
  `[vx, vy, yaw_rate]` carried in the observation;
- **alive bonus** — a small survival term, not the dominant one;
- **control / energy cost** — penalize torque and jerky actuation;
- **early termination on fall** — the episode *ends* when the torso drops.

This inverts the prior incentive structure. Falling is penalized by *removing
future reward* (termination), not rewarded by paying a standing bonus, and the
dominant signal is a dense directional one: move at the commanded velocity. The
gradient therefore points toward locomotion at every step instead of toward
quiet standing. This is the same reward family that has trained real walking
humanoids, so it is a known-good target rather than a bespoke shaping
experiment.

## 3. The integrated approach

**(a) Brax PPO on GPU learns the walking representation.** A single policy is
trained with Brax PPO over thousands of parallel MJX envs (`impl=jax` on CUDA),
producing one network that follows the velocity command. This is the heavy lift
that establishes a real gait.

**(b) Text conditioning re-uses that one policy.** Because the command lives in
the observation, the *same* trained policy pursues different goals depending on
the command vector. `eliza_robot/rl/text_conditioned/joystick_text.py`
(`resolve_command`) deterministically maps free text to `[vx, vy, yaw]` —
"walk forward" → `(1.0, 0.0, 0.0)`, "turn left" → `(0.0, 0.0, 1.0)`,
"stand still" → `(0,0,0)`. No retraining per instruction; text selects the goal.

**(c) Alberta continual learning adds new skills without forgetting.** The
validated mechanism (`alberta_retention_tournament/TOURNAMENT_REPORT.md`) is
per-task heads over a shared CBP-curated trunk. On `joint_reach`:

- `cbp_frozen` (frozen trunk + per-task heads): **ACC 36.46, Forgetting 0.00** —
  beats PPO (ACC 28.48) and the linear lookup (ACC 30.44).
- `cbp_warmupfrz` (learn trunk on task 0, then consolidate): ACC 35.71,
  Forgetting 0.00, higher capacity (mean-diagonal 40.80).
- `cbp_multihead` (plastic shared trunk): highest **capacity 42.36 / ACC 38.94**,
  with Forgetting 5.67 — comparable to PPO's 3.74, the honest shared-net result.
- Disabling the mechanism (`cbp_none`, single shared head) collapses to
  Forgetting 14.83 — i.e. CBP preserves plasticity, not memory.

Layered onto the walking trunk, this lets the agent acquire new text-commanded
skills sequentially while retaining earlier ones.

## 4. Honest caveats

- **CPU-only Stream-AC cannot learn a 12-DoF biped from scratch** — verified, it
  stalls at the immediate-fall optimum. That is precisely why PPO+GPU establishes
  walking and Alberta supplies only the continual layer on top, rather than
  learning the gait online.
- **The retention numbers are from toy `joint_reach`** (a damped
  double-integrator), 2 seeds, 6000 steps/task — suggestive, not conclusive.
- **The frozen-trunk zero-forgetting is by construction.** With a frozen trunk
  and isolated per-task heads, off-diagonal degradation is mathematically
  impossible (`R[T-1][j] == R[j][j]`); it demonstrates zero-interference
  isolation when tasks are routable, not learned robustness in a shared net.
- **Transferring these retention mechanisms onto the learned locomotion policy
  is the open next step**, not a settled result.
