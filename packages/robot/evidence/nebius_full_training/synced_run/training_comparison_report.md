# Alberta Robot Training Final Report

Run: `robot-full-1779504720`
Result: `not-complete`
Monitor state: `running`

## Alberta vs PPO

| field | Alberta | PPO |
|---|---:|---:|
| mean reward | `missing` | `missing` |
| delta vs untrained | `missing` | `missing` |
| Alberta delta vs PPO | `missing` |  |
| winner | `missing` |  |
| untrained mean reward | `missing` |  |

## Method Matrix

| method | role | artifact present | robot mean reward | obstacle ACC | obstacle forgetting |
|---|---|---:|---:|---:|---:|
| `alberta_streaming` | default continual online robot learner | `False` | `missing` | `missing` | `missing` |
| `stable_baselines3_ppo` | matched local robot-policy baseline | `False` | `missing` | `missing` | `missing` |
| `untrained_policy` | zero/untrained control baseline | `False` | `missing` | `missing` | `missing` |
| `brax_mjx_ppo` | SOTA-style accelerator PPO baseline | `False` | `missing` | `missing` | `missing` |

## Continual Learning

| environment | Alberta ACC | Alberta forgetting | PPO ACC | PPO forgetting |
|---|---:|---:|---:|---:|
| joint reach | `missing` | `missing` | `missing` | `missing` |
| obstacle course | `missing` | `missing` | `missing` | `missing` |

## Obstacle Generalization And Forgetting

Obstacle benchmark present: `False`
Alberta ACC delta vs PPO: `missing`
Alberta forgetting delta vs PPO: `missing`
Alberta no catastrophic forgetting observed: `False`
Alberta forgetting not worse than PPO: `False`

## SOTA-Style Baseline

Brax/MJX present: `False`
Regime: `missing`
Steps: `missing`

## Video Evidence

Video review present: `True`
Video review ok: `True`
Video count: `20.0000`
Reviewed profiles: `asimov-1, hiwonder-ainex, unitree-g1, unitree-h1`
OK reviewed videos: `20.0000`
Minimum visual progress: `0.0002`
Mean visual progress: `0.0039`
Mean frame delta: `0.9932`
Production policy video gate ok: `False`
Production video checkpoint: `/home/shaw/milady/eliza/packages/robot/evidence/nebius_full_training/synced_run/checkpoints/asimov_1_alberta_full`

## Alberta End-to-End Evidence Bundle

Report present: `True`
Report ok: `False`
Report production complete: `False`
Report production blocker: `nebius_cli_auth_required`
Report video count: `20.0000`
Report profiles: `asimov-1, hiwonder-ainex, unitree-g1, unitree-h1`
Report backend winner: `missing`
Report obstacle ACC delta: `missing`
Report obstacle forgetting delta: `missing`

## Multi-Robot Video Manifest

Manifest ok: `False`
Require combined videos: `True`
Profiles with complete video evidence: `4.0000` / `5.0000`

| profile | ok | present | expected | combined | missing | too small |
|---|---:|---:|---:|---:|---|---|
| `hiwonder-ainex` | `True` | `5.0000` | `5.0000` | `True` | `none` | `none` |
| `asimov-1` | `True` | `5.0000` | `5.0000` | `True` | `none` | `none` |
| `unitree-g1` | `True` | `5.0000` | `5.0000` | `True` | `none` | `none` |
| `unitree-h1` | `True` | `5.0000` | `5.0000` | `True` | `none` | `none` |
| `unitree-r1` | `False` | `0.0000` | `5.0000` | `False` | `unitree-r1_stand_up.mp4, unitree-r1_walk_forward.mp4, unitree-r1_turn_left.mp4, unitree-r1_turn_right.mp4, unitree-r1_combined_actions.mp4` | `none` |

## Training Inputs And Text Conditioning

Training-input report present: `True`
Training-input report ok: `True`
Launch tasks: `stand_up, walk_forward, walk_backward, sidestep_left, sidestep_right, turn_left, turn_right`
Curriculum SHA256: `cd524c5bf5fce957d4a1eb591db02290952e09a5a54953e6c7c3a53599d5debe`
Offline datasets present: `False`
RL-from-sim ready: `None`
Imitation training ready: `None`
Offline datasets block current plan: `None`
Warnings: `unsupported_future_curriculum_tasks, no_offline_policy_datasets`

## Validation Gate Details

| gate | ok | key checks |
|---|---:|---|
| `training_inputs` | `False` | present, launch_tasks_cover_requested, no_blockers |
| `stage_status` | `False` | runner_status complete, every stage status complete |
| `multi_robot_readiness` | `False` | profiles, per-action videos, combined videos |
| `backend_comparison` | `False` | alberta_vs_ppo_delta, winner_consistent |
| `joint_reach_benchmark` | `False` | alberta_acc_gte_ppo, alberta_forgetting_lte_ppo, learner_seed_pairs |
| `obstacle_course_benchmark` | `False` | alberta_acc_gte_ppo, alberta_forgetting_lte_ppo, learner_seed_pairs |
| `alberta_checkpoint` | `False` | regime, profile, tasks, domain_rand, inference |
| `asimov1_alberta_production` | `None` | production_regime, required_tasks, provenance, inference_check |
| `brax_full_training_run` | `False` | training run contract |
| `brax_production_checkpoint` | `False` | policy artifact, inference_check |
| `video_review` | `True` | action_progress, min_visual_progress |
| `production_policy_videos` | `False` | checkpoint-bound manifest, expected actions |
| `instance_launch_hygiene` | `False` | no inline credentials, repo stage runner, heartbeat uploads |

## Completion Requirements

| requirement | result |
|---|---:|
| `finalization_ok` | `False` |
| `validation_ok` | `False` |
| `stage_status_ok` | `False` |
| `runner_status_complete` | `False` |
| `stage_status_all_complete` | `False` |
| `backend_comparison_present` | `False` |
| `backend_alberta_vs_ppo_delta_ok` | `False` |
| `backend_alberta_delta_vs_untrained_ok` | `False` |
| `backend_ppo_delta_vs_untrained_ok` | `False` |
| `backend_eval_config_ok` | `False` |
| `backend_winner_consistent` | `False` |
| `backend_eval_rollout_depth_ok` | `False` |
| `joint_reach_benchmark_present` | `False` |
| `joint_reach_alberta_acc_gte_ppo` | `False` |
| `joint_reach_alberta_forgetting_lte_ppo` | `False` |
| `joint_reach_task_matrix_ok` | `False` |
| `joint_reach_exact_learner_seed_grid` | `False` |
| `obstacle_course_benchmark_present` | `False` |
| `obstacle_course_alberta_acc_gte_ppo` | `False` |
| `obstacle_course_alberta_forgetting_lte_ppo` | `False` |
| `obstacle_course_task_matrix_ok` | `False` |
| `obstacle_course_exact_learner_seed_grid` | `False` |
| `alberta_checkpoint_ok` | `False` |
| `alberta_checkpoint_regime_streaming` | `False` |
| `alberta_checkpoint_profile_matches` | `False` |
| `alberta_checkpoint_required_tasks` | `False` |
| `alberta_checkpoint_domain_rand` | `False` |
| `alberta_checkpoint_total_steps` | `False` |
| `alberta_checkpoint_inference` | `False` |
| `asimov1_alberta_production_ok` | `False` |
| `asimov1_alberta_regime_streaming` | `False` |
| `asimov1_alberta_required_tasks` | `False` |
| `asimov1_alberta_asset_provenance` | `False` |
| `asimov1_alberta_inference_check` | `False` |
| `brax_mjx_baseline_present` | `False` |
| `brax_full_training_run_ok` | `False` |
| `brax_production_checkpoint_ok` | `False` |
| `brax_regime_ppo` | `False` |
| `brax_profile_matches` | `False` |
| `brax_total_steps_present` | `False` |
| `training_inputs_ok` | `True` |
| `training_inputs_present` | `True` |
| `training_inputs_launch_tasks_cover_requested` | `True` |
| `training_inputs_no_blockers` | `True` |
| `training_inputs_curriculum_hash` | `True` |
| `training_inputs_rl_from_sim_ready` | `False` |
| `training_inputs_offline_datasets_not_blocking` | `False` |
| `multi_robot_readiness_ok` | `False` |
| `multi_robot_video_evidence_ok` | `False` |
| `multi_robot_combined_videos_required` | `True` |
| `multi_robot_video_commands_match` | `True` |
| `multi_robot_video_combined_recording_match` | `True` |
| `video_review_ok` | `True` |
| `alberta_end_to_end_report_present` | `True` |
| `alberta_end_to_end_report_ok` | `False` |
| `alberta_end_to_end_report_video_count_matches` | `True` |
| `alberta_end_to_end_report_video_manifest_consistent` | `True` |
| `alberta_end_to_end_report_evidence_consistent` | `False` |
| `alberta_end_to_end_report_robot_advantage_supported` | `False` |
| `alberta_end_to_end_report_obstacle_advantage_supported` | `False` |
| `alberta_end_to_end_report_production_claim_supported` | `False` |
| `video_action_progress_ok` | `True` |
| `video_min_visual_progress_met` | `True` |
| `video_all_reviewed_ok` | `True` |
| `production_policy_videos_ok` | `False` |
| `production_policy_videos_checkpoint_bound` | `False` |
| `production_policy_videos_checkpoint_exists` | `False` |
| `production_policy_videos_expected_actions` | `True` |
| `instance_launch_hygiene_ok` | `False` |
| `instance_launch_no_inline_credentials` | `False` |
| `instance_launch_repo_stage_runner` | `False` |
| `instance_launch_training_s3_uri` | `False` |
| `instance_launch_heartbeat_upload_contract` | `False` |
| `no_missing_gates` | `False` |

## Missing Production Gates

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
- `artifact_inventory`
