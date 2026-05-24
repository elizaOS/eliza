# Nebius Full Robot Training Validation

Run: `unknown`
Profile: `asimov-1`
Overall result: `not-ready`

## Production Gates

| gate | result |
|---|---:|
| `run_root` | `True` |
| `success_marker` | `False` |
| `failure_marker_absent` | `True` |
| `stage_logs` | `False` |
| `stage_status` | `False` |
| `instance_launch_hygiene` | `False` |
| `training_inputs` | `False` |
| `multi_robot_readiness` | `False` |
| `alberta_checkpoint` | `False` |
| `asimov1_alberta_production` | `False` |
| `backend_comparison` | `False` |
| `joint_reach_benchmark` | `False` |
| `obstacle_course_benchmark` | `False` |
| `brax_full_training_run` | `False` |
| `brax_production_checkpoint` | `False` |
| `video_review` | `True` |
| `production_policy_videos` | `False` |

## Failed Gates

- `success_marker`
- `stage_logs`
- `stage_status`
- `instance_launch_hygiene`
- `training_inputs`
- `multi_robot_readiness`
- `alberta_checkpoint`
- `asimov1_alberta_production`
- `backend_comparison`
- `joint_reach_benchmark`
- `obstacle_course_benchmark`
- `brax_full_training_run`
- `brax_production_checkpoint`
- `production_policy_videos`

## Stage Logs

| stage | ended ok |
|---|---:|
| `00_local_preflight` | `True` |
| `10_nebius_train_alberta` | `False` |
| `20_nebius_compare_backends` | `False` |
| `30_nebius_continual_benchmarks` | `False` |
| `40_nebius_brax_baseline` | `False` |
| `50_post_train_validation` | `False` |

## Production Policy Videos

Gate ok: `False`
Checkpoint: `/home/shaw/milady/eliza/packages/robot/evidence/nebius_full_training/synced_run/checkpoints/asimov_1_alberta_full`
Checkpoint artifacts exist: `False`
Manifest checkpoint bound: `False`
Profile checkpoint bound: `False`
Expected videos present: `True`

| kind | files |
|---|---|
| present | `asimov-1_stand_up.mp4, asimov-1_walk_forward.mp4, asimov-1_turn_left.mp4, asimov-1_turn_right.mp4, asimov-1_combined_actions.mp4` |
| missing | `none` |

## Thresholds

```json
{
  "min_alberta_steps": 150000000,
  "min_backend_compare_steps": 30000,
  "min_benchmark_steps_per_task": 16000,
  "min_benchmark_seeds": 3,
  "require_success": false,
  "run_deep_validators": false
}
```

This report is generated from the synced Nebius object-storage prefix. A completion claim requires every production gate above to be `true`.
