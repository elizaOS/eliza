# Alberta Robot Training Final Report

Run: `robot-full-clean-1779556360`
Result: `not-complete`
Monitor state: `invalid`

## Alberta vs PPO

| field | Alberta | PPO |
|---|---:|---:|
| mean reward | `165.8210` | `194.8435` |
| delta vs untrained | `-85.6840` | `-56.6615` |
| Alberta delta vs PPO | `-29.0226` |  |
| winner | `ppo` |  |
| untrained mean reward | `251.5050` |  |

## Method Matrix

| method | role | artifact present | robot mean reward | obstacle ACC | obstacle forgetting |
|---|---|---:|---:|---:|---:|
| `alberta_streaming` | default continual online robot learner | `True` | `165.8210` | `2.1106` | `0.0000` |
| `stable_baselines3_ppo` | matched local robot-policy baseline | `True` | `194.8435` | `4.0765` | `2.4182` |
| `untrained_policy` | zero/untrained control baseline | `True` | `251.5050` | `missing` | `missing` |
| `brax_mjx_ppo` | SOTA-style accelerator PPO baseline | `True` | `missing` | `missing` | `missing` |

## Continual Learning

| environment | Alberta ACC | Alberta forgetting | PPO ACC | PPO forgetting |
|---|---:|---:|---:|---:|
| joint reach | `38.3013` | `0.0000` | `34.4021` | `10.0449` |
| obstacle course | `2.1106` | `0.0000` | `4.0765` | `2.4182` |

## Obstacle Generalization And Forgetting

Obstacle benchmark present: `True`
Alberta ACC delta vs PPO: `-1.9659`
Alberta forgetting delta vs PPO: `-2.4182`
Alberta no catastrophic forgetting observed: `True`
Alberta forgetting not worse than PPO: `True`

## SOTA-Style Baseline

Brax/MJX present: `True`
Regime: `brax_ppo`
Steps: `1024.0000`

## Video Evidence

Video review present: `True`
Video review ok: `False`
Video count: `28.0000`
Reviewed profiles: `asimov-1, hiwonder-ainex, unitree-g1, unitree-h1, unitree-r1`
OK reviewed videos: `5.0000`
Minimum visual progress: `0.0006`
Mean visual progress: `0.0095`
Mean frame delta: `2.4129`
Production policy video gate ok: `False`
Production video checkpoint: `/home/shaw/milady/eliza/packages/robot/evidence/nebius_full_training/synced_run/checkpoints/asimov_1_alberta_full`

## Multi-Robot Smoke Video Evidence

Smoke review present: `True`
Smoke review ok: `False`
Smoke video count: `40.0000`
Smoke reviewed profiles: `asimov-1, hiwonder-ainex, unitree-g1, unitree-h1, unitree-r1`
Smoke OK reviewed videos: `5.0000`

## Alberta End-to-End Evidence Bundle

Report present: `True`
Report ok: `True`
Report production complete: `False`
Report production blocker: `none`
Report video count: `5.0000`
Report profiles: `asimov-1`
Report backend winner: `ppo`
Report obstacle ACC delta: `-2.0374`
Report obstacle forgetting delta: `-2.7992`

## Multi-Robot Video Manifest

Manifest ok: `True`
Require combined videos: `True`
Profiles with complete video evidence: `5.0000` / `5.0000`

| profile | ok | present | expected | combined | missing | too small |
|---|---:|---:|---:|---:|---|---|
| `hiwonder-ainex` | `True` | `8.0000` | `8.0000` | `True` | `none` | `none` |
| `asimov-1` | `True` | `8.0000` | `8.0000` | `True` | `none` | `none` |
| `unitree-g1` | `True` | `8.0000` | `8.0000` | `True` | `none` | `none` |
| `unitree-h1` | `True` | `8.0000` | `8.0000` | `True` | `none` | `none` |
| `unitree-r1` | `True` | `8.0000` | `8.0000` | `True` | `none` | `none` |

## Training Inputs And Text Conditioning

Training-input report present: `True`
Training-input report ok: `True`
Launch tasks: `stand_up, walk_forward, walk_backward, sidestep_left, sidestep_right, turn_left, turn_right`
Curriculum SHA256: `0bee85e46dc27ad0ee0d04bc72c898827bdf29ac21fc422f39ad1bcea5824068`
Offline datasets present: `False`
RL-from-sim ready: `True`
Imitation training ready: `False`
Offline datasets block current plan: `False`
Warnings: `unsupported_future_curriculum_tasks, no_offline_policy_datasets`

## Validation Gate Details

| gate | ok | key checks |
|---|---:|---|
| `training_inputs` | `True` | present, launch_tasks_cover_requested, no_blockers |
| `stage_status` | `True` | runner_status complete, every stage status complete |
| `multi_robot_readiness` | `True` | profiles, per-action videos, combined videos |
| `backend_comparison` | `True` | alberta_vs_ppo_delta, winner_consistent |
| `joint_reach_benchmark` | `True` | observed ACC/forgetting deltas, enforced delta gates, learner_seed_pairs |
| `obstacle_course_benchmark` | `False` | observed ACC/forgetting deltas, required delta gates, learner_seed_pairs |
| `alberta_checkpoint` | `True` | regime, profile, tasks, domain_rand, inference |
| `asimov1_alberta_production` | `None` | production_regime, required_tasks, provenance, inference_check |
| `brax_full_training_run` | `True` | training run contract |
| `brax_production_checkpoint` | `True` | policy artifact, inference_check |
| `video_review` | `False` | action_progress, min_visual_progress |
| `production_policy_videos` | `False` | checkpoint-bound manifest, expected actions |
| `curriculum_eval` | `False` | checkpoint-bound per-task programmatic success |
| `instance_launch_hygiene` | `True` | no inline credentials, repo stage runner, heartbeat uploads |

## Completion Requirements

| requirement | result |
|---|---:|
| `finalization_ok` | `False` |
| `finalization_report_matches_current_validation` | `False` |
| `validation_ok` | `False` |
| `stage_status_ok` | `True` |
| `runner_status_complete` | `True` |
| `stage_status_all_complete` | `True` |
| `backend_comparison_present` | `True` |
| `backend_alberta_vs_ppo_delta_ok` | `True` |
| `backend_alberta_delta_vs_untrained_ok` | `True` |
| `backend_ppo_delta_vs_untrained_ok` | `True` |
| `backend_eval_config_ok` | `True` |
| `backend_winner_consistent` | `True` |
| `backend_eval_rollout_depth_ok` | `True` |
| `joint_reach_benchmark_present` | `True` |
| `joint_reach_alberta_acc_gte_ppo` | `True` |
| `joint_reach_alberta_forgetting_lte_ppo` | `True` |
| `joint_reach_task_matrix_ok` | `True` |
| `joint_reach_exact_learner_seed_grid` | `True` |
| `obstacle_course_benchmark_present` | `True` |
| `obstacle_course_observed_alberta_acc_gte_ppo` | `False` |
| `obstacle_course_alberta_acc_gte_ppo_gate_passed` | `False` |
| `obstacle_course_alberta_forgetting_lte_ppo` | `True` |
| `obstacle_course_required_delta_gates_ok` | `False` |
| `obstacle_course_task_matrix_ok` | `True` |
| `obstacle_course_exact_learner_seed_grid` | `True` |
| `alberta_checkpoint_ok` | `True` |
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
| `brax_mjx_baseline_present` | `True` |
| `brax_full_training_run_ok` | `True` |
| `brax_production_checkpoint_ok` | `True` |
| `brax_regime_ppo` | `True` |
| `brax_profile_matches` | `True` |
| `brax_total_steps_present` | `True` |
| `training_inputs_ok` | `True` |
| `training_inputs_present` | `True` |
| `training_inputs_launch_tasks_cover_requested` | `True` |
| `training_inputs_no_blockers` | `True` |
| `training_inputs_curriculum_hash` | `True` |
| `training_inputs_rl_from_sim_ready` | `True` |
| `training_inputs_offline_datasets_not_blocking` | `True` |
| `multi_robot_readiness_ok` | `True` |
| `multi_robot_video_evidence_ok` | `True` |
| `multi_robot_combined_videos_required` | `True` |
| `multi_robot_video_commands_match` | `True` |
| `multi_robot_video_combined_recording_match` | `True` |
| `video_review_ok` | `False` |
| `alberta_end_to_end_report_present` | `True` |
| `alberta_end_to_end_report_ok` | `True` |
| `alberta_end_to_end_report_video_count_matches` | `False` |
| `alberta_end_to_end_report_video_manifest_consistent` | `True` |
| `alberta_end_to_end_report_evidence_consistent` | `True` |
| `alberta_end_to_end_report_robot_advantage_supported` | `False` |
| `alberta_end_to_end_report_obstacle_advantage_supported` | `False` |
| `alberta_end_to_end_report_production_claim_supported` | `False` |
| `video_action_progress_ok` | `True` |
| `video_min_visual_progress_met` | `True` |
| `video_all_reviewed_ok` | `False` |
| `production_policy_videos_ok` | `False` |
| `production_policy_videos_checkpoint_bound` | `True` |
| `production_policy_videos_checkpoint_exists` | `True` |
| `production_policy_videos_expected_actions` | `True` |
| `curriculum_eval_ok` | `False` |
| `curriculum_eval_present` | `True` |
| `curriculum_eval_checkpoint_bound` | `True` |
| `curriculum_eval_all_tasks_success` | `False` |
| `curriculum_eval_pass_rate` | `False` |
| `instance_launch_hygiene_ok` | `True` |
| `instance_launch_no_inline_credentials` | `True` |
| `instance_launch_repo_stage_runner` | `True` |
| `instance_launch_training_s3_uri` | `True` |
| `instance_launch_heartbeat_upload_contract` | `True` |
| `no_missing_gates` | `False` |

## Missing Production Gates

- `production_contract`
- `obstacle_course_benchmark`
- `video_review`
- `production_policy_videos`
- `curriculum_eval`
