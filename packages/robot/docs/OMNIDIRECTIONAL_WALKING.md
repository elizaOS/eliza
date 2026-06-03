# Omnidirectional, text-conditioned bipedal walking (Unitree H1)

The canonical engineering recipe for getting a Unitree H1 to robust,
omnidirectional, text-conditioned walking. Distilled from a 2026-05-28 SOTA
review and this repository's own empirical findings. Every env value cited
below is quoted verbatim from
`.venv/.../mujoco_playground/_src/locomotion/h1/joystick_gait_tracking.py`
(`default_config()`), the env this repo trains and proves against.

---

## 1. Proven status

The proven baseline is the stock **`H1JoystickGaitTracking`** playground env
trained with the playground's own Brax-PPO config
(`locomotion_params.brax_ppo_config("H1JoystickGaitTracking")`):

- **8192 environments**, **~100M steps**, MLP actor/critic `(512, 256, 128)`.
- Discounting `0.97`, learning rate `3e-4`, entropy cost `1e-2`, unroll `20`,
  `32` minibatches, `4` updates/batch, clip `0.3`, GAE `0.95`.

This passes the **honest gate** in `eliza_robot/rl/locomotion_metrics.py` /
`eliza_robot/rl/walk_proof.py`, which grades the *real* base-link trajectory and
*real* per-foot floor-contact sensors (`left_foot*_floor_found` /
`right_foot*_floor_found`) — **not** `info["last_contact"]`, which is constantly
`[1, 1]` on H1 and silently zeroed the gait-alternation metric. Under a fixed
`1.0 0.0 0.0` command for 500 steps the proven checkpoint measured:

- forward displacement **~3.75 m** (gate floor `min_forward_distance_m = 0.5`),
- **no fall** (base stays above `min_base_height_m`),
- **21 alternating single-stance contacts** (gate floor `2`),
- **feet lift ~0.30 m** clearance (the env permits `foot_height=[0.08, 0.4]`).

Omnidirectional locomotion works on the stock policy: **forward, backward, and
strafe** all pass their direction-appropriate honest gates in
`eliza_robot/rl/multi_action_eval.py` (`grade_action`).

### Empirically-measured weaknesses (stock recipe)

- **Zero-command backward drift ~0.36 m/s.** On an all-zero command the policy
  never truly stands; it creeps backward. It never explicitly learned "stand".
- **Weak yaw turns.** Turns are sluggish and barely clear the
  `cum_yaw >= 0.6` / `<= -0.6` turn gates.

These two weaknesses are the *only* targets of the refined recipe in §3.
Everything else about the stock recipe is left untouched because it already
walks.

---

## 2. Root cause (from the env config)

The two weaknesses fall directly out of `default_config()`. Quoted verbatim:

```python
reward_config=config_dict.create(
    scales=config_dict.create(
        # Rewards.
        feet_phase=5.0,
        tracking_lin_vel=3.5,
        tracking_ang_vel=0.75,
        feet_air_time=0.0,
        # Costs.
        ang_vel_xy=-0.0,
        lin_vel_z=-0.0,
        pose=-2.5,
        foot_slip=-0.0,
        action_rate=-0.01,
    ),
    tracking_sigma=0.5,
),
command_config=config_dict.create(
    lin_vel_x=[-1.5, 1.5],
    lin_vel_y=[-0.5, 0.5],
    ang_vel_yaw=[-1.0, 1.0],
    lin_vel_threshold=0.1,
    ang_vel_threshold=0.1,
),
```

- **`feet_phase=5.0` dominates `tracking_lin_vel=3.5`.** The phase-locked gait
  reward is the strongest single term, so the policy is rewarded for stepping in
  a clean gait cycle far more than for precisely matching the commanded
  velocity. This biases it toward "keep walking" over "hold the commanded
  velocity (including zero)".

- **`tracking_ang_vel` is only `0.75`** — roughly **1/5 of `tracking_lin_vel`
  (3.5)** and **~1/7 of `feet_phase` (5.0)**. Yaw tracking is structurally
  under-weighted, which is exactly why turns are weak.

- **`sample_command` zeros only PER-AXIS, via the `0.1` thresholds.** The
  sampler draws each axis uniformly from its command range and then zeros that
  *single axis* only when `|axis| < lin_vel_threshold` (or `ang_vel_threshold`),
  both `0.1`:

  ```python
  lin_vel_x = jp.where(jp.abs(lin_vel_x) < cmd_config.lin_vel_threshold, 0, lin_vel_x)
  lin_vel_y = jp.where(jp.abs(lin_vel_y) < cmd_config.lin_vel_threshold, 0, lin_vel_y)
  ang_vel_yaw = jp.where(jp.abs(ang_vel_yaw) < cmd_config.ang_vel_threshold, 0, ang_vel_yaw)
  ```

  A *full* stand-still command (all three axes simultaneously zero) therefore
  occurs only when all three independent draws fall inside their `0.1`
  thresholds: probability **≈ 0.1³ ≈ 0.001** of samples. The policy effectively
  **never sees "stand still"**, so it never learns to hold position on a zero
  command — it minimizes its dominant gait/tracking reward by drifting instead.

This is the mechanism behind both the zero-command backward drift and the weak
turns.

---

## 3. The fix (`scripts/train_omni_h1.py`)

`scripts/train_omni_h1.py` is the research-informed refinement. It changes only
two things and keeps **everything else at the proven default recipe**:

1. **Full-command-zeroing of `--stand-prob` of episodes (default `0.15`).** The
   `OmniH1` subclass overrides `sample_command` to emit an all-zero command for
   ~15% of episodes, so the policy explicitly learns to hold position on a zero
   command:

   ```python
   class OmniH1(JoystickGaitTracking):
       _stand_prob = float(stand_prob)
       def sample_command(self, rng):
           rng, zrng = jax.random.split(rng)
           cmd = super().sample_command(rng)
           stand = jax.random.uniform(zrng) < self._stand_prob
           return jp.where(stand, jp.zeros_like(cmd), cmd)
   ```

   This mirrors **Berkeley-Humanoid-Lite** (`rel_standing_envs`) and **Seo et
   al. 2025** ("zero target velocity 20%"), which zero the *whole* command for
   2–20% of episodes rather than per-axis.

2. **Moderate `tracking_ang_vel` boost (default `2.0`, up from `0.75`).** Just
   enough to make turns crisp without destabilizing the proven gait:

   ```python
   cfg.reward_config.scales.tracking_ang_vel = float(tracking_ang_vel)
   ```

### What NOT to do (empirically verified)

Do **not** apply the `foot_slip` override (e.g. `foot_slip=-1.0`). It HURT: it
**trapped learning at reward ~5** instead of the proven trajectory. The stock
`foot_slip=-0.0` is deliberate; aggressive penalty overrides are how the policy
gets stuck in a foot-skating local optimum (see the RL-stack audit
2026-05-28: "reward magnitude does not imply walking" — a separate run reached
reward 8.4 while foot-skating). Keep the cost terms at their default
(`pose=-2.5`, `action_rate=-0.01`, the rest `-0.0`) and let the honest gate, not
reward magnitude, be the source of truth.

---

## 4. SOTA reward stack (what a strong humanoid-walking reward looks like)

The 2026-05-28 review and this env agree on the shape of a good reward stack.
Ordered by intent:

1. **Velocity tracking is dominant.** `tracking_lin_vel` (+ a yaw term that is
   not starved — the stock `0.75` is too low). This is the task signal; it must
   outweigh shaping.
2. **Gait shaping:** `feet_phase` (phase-locked stepping), feet **air-time** and
   foot **clearance**. The env exposes `feet_air_time` (default scale `0.0`) and
   `foot_height=[0.08, 0.4]`; air-time reward is explicitly gated off for
   near-zero commands (`rew_air_time *= cmd_norm > 0.05`) so standing is not
   penalized for not stepping.
3. **SMALL foot-slip penalty.** Foot-slip should sit **~20× below** the velocity
   tracking weight, not anywhere near it. The stock value is `foot_slip=-0.0`;
   the lesson from §3 is that pushing it to `-1.0` (well above 1/20 of
   `tracking_lin_vel=3.5`) traps learning.
4. **Regularizers:** orientation/`pose` (`-2.5`), torque/energy, `action_rate`
   (`-0.01`), and a **termination** signal — the env terminates on
   `joint_limit_exceed | fall_termination` with `early_termination=True` and a
   fall when projected gravity-z `< 0.85`.
5. **Curriculum-ramp the penalties.** Bring shaping/penalty terms up over
   training rather than starting them at full strength, so early exploration is
   not crushed.

This repo's own envs (`sim/mujoco/joystick.py`, `getup.py`,
`text_conditioned.py`) had a reward clip of `[0, 10000]` that zeroed every
penalty term and enabled foot-skating; the fix (lower bound `-10.0`, matching
sibling envs) is recorded in `docs/rl-stack-audit-2026-05-28.md`.

---

## 5. Robustness and sim2real

Train startup/reset domain randomization so the policy is not brittle. The repo
randomizer (`eliza_robot/sim/mujoco/randomize.py`, `domain_randomize`) covers,
verbatim from its header: *floor friction, joint friction loss, armature, link
masses, torso mass, CoM position, default qpos, actuator gains, joint damping,
motor strength, and action execution noise.* Concrete ranges it applies:

- **Floor friction** `U(0.4, 1.2)`.
- **Joint friction loss** scaled `×U(0.9, 1.1)` (freejoint DOFs skipped).
- **All link masses** scaled `×U(0.9, 1.1)`; **torso mass** additional
  `+U(-0.05, 0.05)`.
- **CoM position** jitter `+U(-0.005, 0.005)`.
- **Actuator gains (stiffness)** scaled `×U(0.9, 1.1)`, with bias kept coupled
  (`biasprm[:,1] = -gainprm[:,0]`).
- **Action execution noise** `N(0, U(0.0, 0.02))` (servo bus jitter / position
  error), added to actions before they are applied.

The H1 env's own observation noise is on by default
(`obs_noise.level=0.6`, scales `joint_pos=0.01`, `joint_vel=1.5`, `gyro=0.2`,
`gravity=0.05`) — keep it; it is sensor-noise robustness for free. Joint-offset
randomization belongs in the same startup-randomization pass.

For terrain robustness, **finetune on Perlin rough terrain** after the flat-floor
policy passes the honest gate. Do it as a finetune, not from scratch.

### Known gap: push perturbations

**Push-perturbation (external-force) training is a known gap** in the on-policy
PPO recipe here. The SOTA answer for recovering from shoves is **off-policy
FastTD3**, which handles perturbation robustness better than PPO at this scale.
Treat push-recovery as follow-up on a FastTD3 backend, not as a tweak to the
PPO recipe above.

---

## 6. Text conditioning

Two distinct surfaces. Do not conflate them.

### Locomotion (forward/back/strafe/turn/stand) — text → velocity bridge

In THIS repo the pragmatic, proven path is: the **velocity-conditioned PPO
policy** from §1/§3 plus a **text→velocity bridge**,
`eliza_robot/rl/meta/locomotion_command.py` (`velocity_from_text` /
`velocity_from_parse`). The bridge is pure (no sim/jax/torch) and maps parsed
free-form text to the `[vx, vy, vyaw]` command the policy already consumes,
clamped into the training ranges:

```python
MAX_FORWARD_SPEED_M_S = 1.0   # in H1 lin_vel_x [-1.5, 1.5]
MAX_LATERAL_SPEED_M_S = 0.5   # in H1 lin_vel_y [-0.5, 0.5]
MAX_YAW_RATE_RAD_S    = 1.0   # in H1 ang_vel_yaw [-1.0, 1.0]
```

`multi_action_eval.py` proves the full text→action loop end to end: it maps each
canonical phrase ("walk forward", "walk backward", "turn left/right", "sidestep
left/right", "stop") through the bridge and grades the resulting rollout against
that action's honest gate.

### Non-locomotion actions (sit / wave / look / gesture)

The SOTA answer for *non-locomotion* whole-body actions from text is a **single
end-to-end language-conditioned policy via distillation** — concretely
**LangWBC**: a CLIP-512 text embedding conditions a CVAE *student* that is
**distilled from an RL MoCap-tracking teacher**. It is explicitly **NOT** a
skill-library + selector, and **NOT** PPO-trained-directly-from-text.

In THIS repo the pragmatic path is to keep the velocity-conditioned PPO policy +
text→velocity bridge for everything that is locomotion, and use
**scripted / skill actions for gestures** (sit, wave, look). A LangWBC-style
single unified policy is the longer-term direction, not the current shipping
path.

---

## 7. Exact commands

### Train (refined omnidirectional, stand-capable policy)

```bash
ELIZA_ROBOT_USE_GPU=1 uv run python scripts/train_omni_h1.py \
    --num-timesteps 150000000 --num-envs 8192 \
    --stand-prob 0.15 --tracking-ang-vel 2.0 \
    --out /tmp/robotwalk/h1_omni
```

Defaults already encode the recipe: `--num-timesteps 150000000`,
`--num-envs 8192`, `--stand-prob 0.15`, `--tracking-ang-vel 2.0`. Set
`ELIZA_ROBOT_USE_GPU=1` to use the GPU (otherwise JAX falls back to CPU).
Checkpoints land at `<out>/final_params`.

### Prove single-direction walking (honest gate)

```bash
JAX_PLATFORMS=cpu MUJOCO_GL=egl uv run python -m eliza_robot.rl.walk_proof \
    --env H1JoystickGaitTracking --ckpt /tmp/robotwalk/h1_omni/final_params \
    --command 1.0 0.0 0.0 --eval-steps 500 --render --out /tmp/proof
```

### Prove all directions + text→action loop

```bash
JAX_PLATFORMS=cpu MUJOCO_GL=egl uv run python -m eliza_robot.rl.multi_action_eval \
    --env H1JoystickGaitTracking --ckpt /tmp/robotwalk/h1_omni/final_params \
    --eval-steps 350 --render --out /tmp/multi_action
```

`multi_action_eval` writes `multi_action_eval.json` with per-action `passed` /
`fail_reasons` and an `all_pass` summary, plus one MP4 per action when
`--render` is set. This is the authoritative "one velocity-conditioned RL
policy, many text actions" proof.

---

## References

- `mujoco_playground` `H1JoystickGaitTracking` `default_config()` — env config
  values quoted verbatim above.
- `scripts/train_omni_h1.py` — the refined training recipe.
- `eliza_robot/rl/walk_proof.py`, `eliza_robot/rl/locomotion_metrics.py` — the
  honest single-direction gate.
- `eliza_robot/rl/multi_action_eval.py` — the all-directions + text→action gate.
- `eliza_robot/rl/meta/locomotion_command.py` — the text→velocity bridge.
- `eliza_robot/sim/mujoco/randomize.py` — startup domain randomization.
- `docs/rl-stack-audit-2026-05-28.md` — "reward magnitude does not imply
  walking"; reward-clip and foot-skating findings.
- Berkeley-Humanoid-Lite (`rel_standing_envs`), Seo et al. 2025 (zero target
  velocity 20%) — full-command-zeroing for stand capability.
- LangWBC — CLIP-512 text → CVAE student distilled from an RL MoCap-tracking
  teacher, for text-conditioned non-locomotion whole-body actions.
- FastTD3 — off-policy backend for push-perturbation robustness.
