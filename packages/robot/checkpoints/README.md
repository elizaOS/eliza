RL checkpoints land here at runtime. The directory itself is gitignored — only this README and .gitkeep are tracked.

## Orphaned checkpoints (do not trust as walking policies)

`text_conditioned_brax_v2_sota_250m` (reward ~30.8) and `text_conditioned_brax_v3_step98M`
are **orphaned**: they were trained with a 277-obs / 24-action / 11-task
text-conditioned env (tasks incl. `sit_down` / `look_up` / `look_down`, with
arm + head actuation and head-tilt / sit reward terms). That env was later
refactored away — no env in the current tree produces that obs/action layout
(the MJX `text_conditioned.py` is 5-task / 12-action, `profile_env` rejects the
look-* tasks). They **cannot be faithfully loaded, evaluated, rendered, or
deployed**. `TextConditionedPolicy` will pad/trim the obs and emit *something*,
but it is garbage — not the trained behaviour. Treat the reward curve as a
historical artifact, not a usable policy. Verified by the 2026-05-28 adversarial
review.

## The real walking path

Trained, verifiable bipedal-walking policies come from the off-the-shelf
mujoco_playground locomotion trainer:

```
uv run python scripts/train_playground_locomotion.py --env H1JoystickGaitTracking ...
uv run python -m eliza_robot.rl.walk_proof --env H1JoystickGaitTracking --ckpt <dir>/final_params --render --out evidence/h1_walk_proof
```

`walk_proof` grades the rollout with the honest gate in
`eliza_robot/rl/locomotion_metrics.py` (net forward displacement at ~commanded
speed, real alternating foot-contact switches from the floor sensors, upright,
no fall) and is the single source of truth for "does this checkpoint walk".
