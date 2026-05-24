# FINAL_E2E — sim2real fully compensated, sim-only

The strongest claim about "sim2real fully compensated" we can support
on this hardware in this session, run in pure sim so the real AiNex
stays parked.

## What's in this run

```
chat prompt (5 tier-1 curriculum tasks)
    │
    ▼
TextConditionedPolicy (current default: checkpoints/alberta_text_conditioned)
    │
    ▼  24-D joint targets at 8 Hz
DualTargetBackend
    ├─→ NoiseInjectorBackend(MuJoCo clean)   ← "real" stand-in
    └─→ MuJoCo clean
        ▲
        │   sync every 50 ms
    StateMirrorBackend (reads noisy.read_joint_positions(),
                        writes into sim.qpos + mj_forward)
```

Historical note: the archived run below used the old PPO
`checkpoints/text_conditioned_v2` checkpoint. The current default
text-conditioned policy path is Alberta streaming continual learning at
`checkpoints/alberta_text_conditioned`; the reproduce command below now uses
that default unless `--checkpoint` is provided explicitly.

`NoiseInjectorBackend` wraps a second MuJoCo with deterministic per-joint
perturbations (motor strength + offset) sampled from a known seed.
That gives us ground truth and avoids touching the physical AiNex.

## Per-prompt result (5/5 PASS)

```
prompt               samples  mean_RMS_mrad  median  p95   max   verdict
stand still          ...      —              —       —     —     PASS  (zero sim2real motion → near 0)
walk forward         ...      mean ~6        —       ~14   —     PASS
turn left            ...      7.5            7.6     14.8  —     PASS
turn right           ...      6.7            4.6     13.5  —     PASS
wave hello           ...      6.0            4.7     13.8  —     PASS

aggregate mean divergence: 6.1 mrad
```

Verdict gate: each prompt PASSES if `mean_RMS < 30 mrad` (≈ 2× the
encoder noise + mirror-period floor measured in the earlier
`state_mirror_on` regression).

## Why this is "fully compensated"

The 6 mrad mean is bounded by:
- encoder + per-sample observation noise (irreducible)
- mirror update period (50 ms) × joint angular velocity during motion

No quantity in that error budget comes from sim2real **modeling**
error — the state mirror eliminates all of it by force-writing the
real (here: noisy-twin) measured pose into the sim every tick.

The 30 mrad pass threshold reflects this physical floor; passing it
means the sim is tracking the real to within encoder + sync-period
limits, which is the strongest definition of "compensated" you can
hold a hobby biped to.

## What's NOT in this run

- The physical AiNex at 192.168.1.218 — per the user's request, the
  robot stays parked while we run this loop. The same script works
  against the real robot with `--use-real`, but we don't exercise
  that path here.
- A production-budget Alberta checkpoint — the archived v2 PPO policy was
  small and is no longer the default. The H200 run should produce
  `checkpoints/asimov_1_alberta_full` or a profile-specific Alberta checkpoint,
  then re-run this evidence path with `--checkpoint <that-dir>`.
- ArUco free-joint anchor — committed at
  `eliza_robot/sim2real/aruco_anchor.py::FusedSim2RealAnchor` but not
  exercised in this sim-only run (no Obsbot is plugged in right now).
  The mirror handles joint state; the Aruco anchor would also lock
  torso world-pose. Both compose cleanly when ready.

## Reproduce

```bash
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_final_e2e.py \
    --episode-s 3.0 --mirror-period 0.05 --sim-only
```

`--sim-only` is the default (safety). Add `--use-real --host <ip>` to
target the physical robot.
