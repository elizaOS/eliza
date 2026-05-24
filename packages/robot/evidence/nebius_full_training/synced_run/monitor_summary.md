# Nebius Full Training Monitor

Run: `robot-full-1779504720`
State: `running`
Observed: `2026-05-23T17:02:58.013310Z`
Next action: `continue_polling`

## Stage Progress

Completed: `1` / `6`

| stage | status |
|---|---:|
| `00_local_preflight` | `done` |
| `10_nebius_train_alberta` | `pending` |
| `20_nebius_compare_backends` | `pending` |
| `30_nebius_continual_benchmarks` | `pending` |
| `40_nebius_brax_baseline` | `pending` |
| `50_post_train_validation` | `pending` |

## Missing Gates

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

## Passed Gates

- `run_root`
- `failure_marker_absent`
- `video_review`
