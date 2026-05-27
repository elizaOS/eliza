# Nebius Full Robot Training Validation

Run: `unknown`
Profile: `asimov-1`
Overall result: `not-ready`

## Production Gates

| gate | result |
|---|---:|
| `run_root` | `True` |
| `success_marker` | `True` |
| `failure_marker_absent` | `True` |
| `stage_logs` | `True` |
| `stage_status` | `False` |
| `production_contract` | `False` |
| `instance_launch_hygiene` | `True` |
| `training_inputs` | `True` |
| `multi_robot_readiness` | `True` |
| `alberta_checkpoint` | `True` |
| `asimov1_alberta_production` | `True` |
| `backend_comparison` | `True` |
| `joint_reach_benchmark` | `True` |
| `obstacle_course_benchmark` | `True` |
| `brax_full_training_run` | `True` |
| `brax_production_checkpoint` | `True` |
| `video_review` | `False` |
| `production_policy_videos` | `False` |
| `curriculum_eval_native` | `True` |
| `curriculum_eval` | `False` |
| `status_consistency` | `False` |

## Failed Gates

- `stage_status`
- `production_contract`
- `video_review`
- `production_policy_videos`
- `curriculum_eval`
- `status_consistency`

## Stage Logs

| stage | ended ok |
|---|---:|
| `00_local_preflight` | `True` |
| `10_nebius_train_alberta` | `True` |
| `20_nebius_compare_backends` | `True` |
| `30_nebius_continual_benchmarks` | `True` |
| `40_nebius_brax_baseline` | `True` |
| `50_post_train_validation` | `True` |

## Production Policy Videos

Gate ok: `False`
Checkpoint: `/home/shaw/milady/eliza/packages/robot/evidence/nebius_full_training/synced_run/checkpoints/asimov_1_alberta_full`
Checkpoint artifacts exist: `True`
Manifest checkpoint bound: `True`
Profile checkpoint bound: `True`
Expected videos present: `True`
Expected telemetry present: `True`

| kind | files |
|---|---|
| present | `asimov-1_stand_up.mp4, asimov-1_walk_forward.mp4, asimov-1_walk_backward.mp4, asimov-1_sidestep_left.mp4, asimov-1_sidestep_right.mp4, asimov-1_turn_left.mp4, asimov-1_turn_right.mp4, asimov-1_combined_actions.mp4` |
| missing | `none` |

## Thresholds

```json
{
  "min_alberta_steps": 150000000,
  "min_backend_compare_steps": 30000,
  "min_benchmark_steps_per_task": 16000,
  "min_benchmark_seeds": 3,
  "require_success": true,
  "run_deep_validators": false
}
```

This report is generated from the synced Nebius object-storage prefix. A completion claim requires every production gate above to be `true`.
