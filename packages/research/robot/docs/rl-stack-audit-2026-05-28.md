# packages/robot RL-stack audit — 2026-05-28

Adversarially-verified audit (43 agents: 8 read-only reviewers across subsystems
→ per-finding refutation verifiers). 30 findings survived verification; each was
then re-read by hand before action. Dispositions below.

## Fixed (committed)

| # | Severity | File | Issue | Fix |
|---|---|---|---|---|
| 1 | critical | sim/mujoco/joystick.py:191 | reward clipped `[0,10000]` zeroed ALL penalty terms (feet_slip, lin_vel_z, orientation, energy, action_rate) → enables foot-skating | lower bound → `-10.0` (matches 5 sibling envs) |
| 2 | critical | sim/mujoco/getup.py:215 | same reward clip | `-10.0` |
| 3 | critical | sim/mujoco/text_conditioned.py:242 | same reward clip | `-10.0` |
| 4 | critical | bridge/safety.py:74 | `check_policy_motion_bounds` always `allowed=True`; NaN/inf passed through unclamped (`abs(nan)>MAX` is False) to the robot | reject non-finite/garbage → `allowed=False`, neutralized payload; +4 tests |
| 0 | critical | rl/text_conditioned/inference_loop.py | proprio `last_action` block zero-filled every step (OOD vs training) and qpos offset was 9 not 20 | track prev leg action across steps + correct offsets; +tests |
| 6 | critical | sim2real/calibration.py:124 | empty-trajectory branch missing `rms_total` → caller `KeyError` | add `rms_total: 0.0` |
| 11 | high | rl/meta/text_encoder.py:33 | BoW hash loop capped at `min(16,dim)` → only ~16 of `dim` bins used | stretch md5 with counter to fill all `dim` |
| 15 | high | sim2real/calibration.py:57 | `apply_to` drove uncommanded joints to `0.0+offset` | only calibrate joints present in input |

## Rejected — false positives (intended behavior; verified by reading)

| # | File | Why it is NOT a bug |
|---|---|---|
| 13 | sim/mujoco/getup.py:322 | `jp.minimum(torso_z, z_des)` is a deliberate overshoot cap: "standing or taller" counts as reached. Not backwards. |
| 17 | scripts/validate_alberta_robot_checkpoint.py:150 | `failure_rate <= 0.0` (require zero failures) is intentional fail-closed strictness; audit's `<0.01` would *loosen* a production gate. |
| 7 | scripts/validate_asimov1_real_agent_readiness.py:106 | `production_ready` requiring BOTH validations regardless of `require_*` is correct strict semantics; `require_*` gates the separate `ok` field. |
| 14 | bridge/openpi_adapter.py:137 | raising `ValueError` on a too-short action vector is correct fail-loud; fabricating a fallback would be wrong. |

## Deferred — real but low-impact / needs care (tracked, not yet fixed)

| # | Severity | File | Note |
|---|---|---|---|
| 8 | high | rl/text_conditioned/env.py:242 | action-rate penalty uses `mean(action**2)` (magnitude) not jerk — but `TextConditionedJoystickEnv` is **dead** (no live instantiation; superseded by `profile_env.py`). Right fix = delete the module after knip-style confirmation. |
| 9 | high | rl/text_conditioned/env.py | same dead env; missing separate energy penalty |
| 24 | medium | sim/mujoco/randomize.py:119 | `action_noise_scale` computed-but-unapplied, but **documented** as intentional; removing it shifts the DR RNG stream (behavior change) |
| 10 | high | rl/skills/walk_skill.py:71 | silent checkpoint-load failure when model is a dict (legacy PyTorch skill) |
| 12 | high | rl/skills/brax_walk_skill.py:268 | leg-velocity scaling assumes fixed 50 Hz; call-rate dependent |
| 16 | high | sim2real/calibration.py, sysid.py | zero test coverage on calibration/sysid |
| 18 | medium | rl/text_conditioned/encoder.py:196 | PCA skipped when `pca_dim>=384` but manifest doesn't reflect actual shape |
| 19 | medium | rl/text_conditioned/profile_env.py:1361 | foot-spacing penalty asymmetric on sign of lateral_sep |
| 20 | medium | rl/alberta/agent.py:247 | log_sigma restore then immediate overwrite in decouple mode |
| 22 | medium | sim/mujoco/joystick.py:198 | step-counter reset vs command-resample/termination timing |
| 23 | medium | sim/mujoco/base_env.py:422 | obs noise clipped before adding (noise can exceed bounds) |
| 25 | medium | bridge/openpi_adapter.py:181 | `Any` used in annotation without import (harmless under `from __future__ import annotations`) |
| 26 | medium | bridge/validation.py:76 | walk.set accepts two formats with confusing flow |
| 29 | low | bridge/server.py:695 | `isaaclab.joint_map` imported inside policy.tick hot path |

## Headline takeaway

**Reward magnitude does not imply walking.** Independently of this audit, a fresh
H1 (`mujoco_playground:H1JoystickGaitTracking`) PPO run reached reward 8.4 while
**foot-skating** (`feet_air_time=[0,0]`, both feet planted, sliding then
collapsing) — caught only by the honest contact/displacement gate in
`eliza_robot/rl/locomotion_metrics.py`. Finding #1 (penalties clipped to zero) is
a direct structural cause of that failure mode in our own envs.
