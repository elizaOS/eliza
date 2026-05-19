# FINAL_GOAL — eliza agent → trained model → sim + real simultaneously

This document tracks every artifact that backs the
"text-conditioned RL on AiNex + MuJoCo with sim2real" goal.

## The loop, drawn out

```
chat prompt → plugin-ainex's AINEX_RUN_RL or programmatic action
                  │
                  ▼  (policy.start{task=text} over the unified bridge)
       TextConditionedPolicy
       (checkpoint @ checkpoints/text_conditioned_v2/policy.zip,
        sentence-transformers/all-MiniLM-L6-v2 text encoder,
        429-D obs = 45-D proprio + 384-D text)
                  │
                  ▼  24-D joint targets at 8-10 Hz
            DualTargetBackend
             ┌──────────────────┬──────────────────┐
             ▼                  ▼                  ▼
        AinexRemoteBackend  CalibratedBackend  sim2real divergence
        (real AiNex via    (wraps the sim     event surfaced for
        rosbridge_suite    leg with the       evaluation/calibration
        at 192.168.1.218)  per-joint α, β
                           recovered from
                           real sys-ID)
             │                  │
             ▼                  ▼
         physical motors    MuJoCo DemoEnv
```

## Per-component evidence

### 1. Curriculum and text conditioning
- `eliza_robot/curriculum/tasks.yaml` — 22 tasks × 5 languages × 7.5 variants on average = **165 text variants**.
- `eliza_robot/curriculum/loader.py` — multi-lingual lookup verified
  (`'walk forward'`, `'前に歩け'`, `'shuffle to the right'` all resolve correctly).
- `eliza_robot/rl/text_conditioned/encoder.py` — sentence-transformers
  embedding cache (built once, ~22 s on first run, instant thereafter).

### 2. Trained policy
- `checkpoints/text_conditioned_v2/policy.zip` — 8192 PPO steps,
  4-task subset (stand_up, walk_forward, turn_left, turn_right),
  ep_rew_mean climbed 366 → 829, manifest.json describes the
  obs/action shape (429, 24).
- Conditioning is verifiably real: same proprio, different text →
  mean off-diagonal action L2 = 0.014, max 0.020 (`sim_validation_gate`
  gate-2 PASS).
- v3 (30k steps) currently training in the background. Plateauing at
  the same ep_rew (~700) because the env's reward landscape — not
  training time — is the bottleneck. The next improvement is migrating
  the env to MJX-Brax for many parallel envs on the local 5080 GPU.

### 3. Bridge — sim + real, unified protocol
- `bridge/backends/ainex_remote.py` — `roslibpy` client to the AiNex's
  rosbridge_suite. Reads `/walking/is_walking`, `/imu`,
  `/ros_robot_controller/battery`, `/camera/image_raw/compressed`.
  `read_joint_positions()` calls
  `/ros_robot_controller/bus_servo/get_position` service synchronously.
- `bridge/backends/dual_target.py` — broadcasts every command to both
  legs concurrently, surfaces `sim2real.divergence` events.
- `bridge/backends/calibrated.py` — wraps a backend with a per-joint
  affine map loaded from a sys-ID JSON.

### 4. Sim2real calibration
- `scripts/evidence_real_robot_sysid.py` ran against the physical
  AiNex at 192.168.1.218. The closed-form least-squares fit recovered
  12 joints; the result lives at
  `calibration/ainex_192_168_1_218.json` and
  `evidence/real_robot_sysid/ainex_calibration.json`. Key fits:

      head_pan     α= 0.99  β=  -6.7 mrad  rmse=  3.9 mrad
      head_tilt    α= 0.94  β= -12.5 mrad  rmse=  9.5 mrad
      r_sho_pitch  α= 1.01  β= -10.0 mrad  rmse=  5.6 mrad
      r_sho_roll   α= 0.87  β=+139.5 mrad  rmse= 20.6 mrad
      r_gripper    α= 0.99  β=  -5.9 mrad  rmse=  3.9 mrad
      l_sho_pitch  α= 1.00  β=  -4.2 mrad  rmse=  4.2 mrad
      l_sho_roll   α= 1.00  β= -13.7 mrad  rmse=  1.7 mrad
      l_el_yaw     α= 1.00  β=  -7.5 mrad  rmse=  1.2 mrad
      l_gripper    α= 0.98  β=  -8.4 mrad  rmse=  4.2 mrad
      (r_el_yaw, l_el_pitch excluded — α≈0, joints did not track probe)

- `eliza_robot/sim2real/sysid.py` — closed-form least-squares fit
  per joint, probes relative to the joint's home pose, subtracts home
  from β to recover the calibrable offset.
- Pure-sim validation (`sim_validation_gate.py`) recovers per-joint
  offsets within **4.73 mrad median** of injected ground truth on the
  noisy-sim twin (gate-3 PASS).

### 5. End-to-end runs
- `evidence/text_to_action_e2e_v1/` — v1 (1024-step) checkpoint
  drove sim+real for 4 prompts × 24 servo.set commands each. Plumbing
  proven, motion small (policy under-trained).
- `evidence/calibrated_e2e/` — v2 checkpoint through `CalibratedBackend`,
  3 prompts:
    - "stand still" → matched stand_up, sim=0.71, 32 steps
    - "wave hello"  → matched wave_right, sim=0.71, 32 steps
    - "turn left"   → matched turn_left, sim=0.83, 32 steps
- `evidence/calibrated_e2e_uncalibrated/` — same run without
  calibration, for A/B comparison.

### 6. Sim2real validation gate (all PASS)

```
g1 training       PASS  — checkpoint loads + emits 24-D action per prompt
g2 conditioning   PASS  — mean off-diagonal action L2 > 0.001 threshold
g3 sysid          PASS  — median offset recovery 4.73 mrad ≤ 15 mrad
g4 bridge_dual    PASS  — DualTargetBackend accepts 4-command program
VERDICT: PASS
```

(`evidence/sim_validation_gate/sim_validation_gate.json`)

## What's still partial

Per-tick sim2real divergence measured in the e2e run is dominated by:
1. **Leg joints (12 of 24)** — were never probed in sys-ID because
   probing legs from a standing pose tips the robot. Next iteration:
   lay the robot prone and probe legs separately.
2. **Two arm joints** (r_el_yaw, l_el_pitch) — sys-ID excluded them
   because α came back near 0 (mechanical limit / weight loading on
   the AiNex's hobby servos).
3. **Starting-pose drift** — the real robot wasn't always at the
   nominal stand pose when the run started; the sim always was. The
   ArucoAnchor (`sim2real/aruco_anchor.py`) closes this gap when an
   external camera is present.

The infrastructure to address all three is committed; the data
collection just hasn't been done in this session.

## Reproduce everything

```bash
cd packages/robot
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python -m eliza_robot.rl.text_conditioned.train --smoke --steps 8192
PYTHONPATH=. .venv/bin/python scripts/evidence_real_robot_sysid.py --host 192.168.1.218
PYTHONPATH=. .venv/bin/python scripts/evidence_text_to_action_calibrated_e2e.py
PYTHONPATH=. .venv/bin/python scripts/sim_validation_gate.py
```

The gate exits 0 only when all four sim-side checks pass; the e2e
exercises both real and sim simultaneously through the calibrated
dual-target backend; the sys-ID writes calibration data for the
specific robot at the specified host.
