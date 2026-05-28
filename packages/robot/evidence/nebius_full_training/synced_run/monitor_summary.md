# Nebius Full Training Monitor

Run: `robot-full-clean-1779556360`
State: `invalid`
Observed: `2026-05-27T22:10:57.922857Z`
Next action: `inspect_failed_validation_gates`

## Stage Progress

Completed: `6` / `6`

| stage | status |
|---|---:|
| `00_local_preflight` | `done` |
| `10_nebius_train_alberta` | `done` |
| `20_nebius_compare_backends` | `done` |
| `30_nebius_continual_benchmarks` | `done` |
| `40_nebius_brax_baseline` | `done` |
| `50_post_train_validation` | `done` |

## Missing Gates

- `stage_status`
- `production_contract`
- `obstacle_course_benchmark`
- `video_review`
- `production_policy_videos`
- `curriculum_eval`
- `status_consistency`

## Passed Gates

- `run_root`
- `success_marker`
- `failure_marker_absent`
- `stage_logs`
- `instance_launch_hygiene`
- `training_inputs`
- `multi_robot_readiness`
- `alberta_checkpoint`
- `asimov1_alberta_production`
- `backend_comparison`
- `joint_reach_benchmark`
- `brax_full_training_run`
- `brax_production_checkpoint`
- `curriculum_eval_native`
