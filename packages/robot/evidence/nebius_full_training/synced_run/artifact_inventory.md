# Nebius Training Artifact Inventory

Result: `incomplete`
Present: `55` / `90`
Generated: `2026-05-23T17:59:28.132150Z`

## Category Summary

| category | present | required | missing |
|---|---:|---:|---|
| `backend_comparison` | `0` | `2` | `backend_comparison_json, backend_comparison_md` |
| `checkpoints` | `0` | `4` | `alberta_manifest, alberta_policy, brax_manifest, brax_policy` |
| `continual_benchmarks` | `0` | `6` | `joint_reach_benchmark_json, joint_reach_benchmark_md, joint_reach_benchmark_plot, obstacle_course_benchmark_json, obstacle_course_benchmark_md, obstacle_course_benchmark_plot` |
| `review_reports` | `12` | `12` | `none` |
| `stage_status` | `0` | `13` | `status_success, runner_status, status_00_local_preflight, status_10_nebius_train_alberta, status_20_nebius_compare_backends, status_30_nebius_continual_benchmarks, status_40_nebius_brax_baseline, status_50_post_train_validation, log_train_alberta, log_compare_backends, log_continual_benchmarks, log_brax_baseline, log_post_train_validation` |
| `training_inputs` | `1` | `1` | `none` |
| `video_evidence` | `42` | `52` | `multi_robot_video_unitree_r1_stand_up, multi_robot_video_unitree_r1_walk_forward, multi_robot_video_unitree_r1_turn_left, multi_robot_video_unitree_r1_turn_right, multi_robot_video_unitree_r1_combined, multi_robot_contact_unitree_r1_stand_up, multi_robot_contact_unitree_r1_walk_forward, multi_robot_contact_unitree_r1_turn_left, multi_robot_contact_unitree_r1_turn_right, multi_robot_contact_unitree_r1_combined` |

## Artifact Detail

| artifact | present | bytes | path |
|---|---:|---:|---|
| `status_success` | `False` | `0` | `status/success.txt` |
| `runner_status` | `False` | `0` | `status/runner_status.json` |
| `status_00_local_preflight` | `False` | `0` | `status/00_local_preflight.json` |
| `status_10_nebius_train_alberta` | `False` | `0` | `status/10_nebius_train_alberta.json` |
| `status_20_nebius_compare_backends` | `False` | `0` | `status/20_nebius_compare_backends.json` |
| `status_30_nebius_continual_benchmarks` | `False` | `0` | `status/30_nebius_continual_benchmarks.json` |
| `status_40_nebius_brax_baseline` | `False` | `0` | `status/40_nebius_brax_baseline.json` |
| `status_50_post_train_validation` | `False` | `0` | `status/50_post_train_validation.json` |
| `log_train_alberta` | `False` | `0` | `logs/10_nebius_train_alberta.log` |
| `log_compare_backends` | `False` | `0` | `logs/20_nebius_compare_backends.log` |
| `log_continual_benchmarks` | `False` | `0` | `logs/30_nebius_continual_benchmarks.log` |
| `log_brax_baseline` | `False` | `0` | `logs/40_nebius_brax_baseline.log` |
| `log_post_train_validation` | `False` | `0` | `logs/50_post_train_validation.log` |
| `training_inputs_report` | `True` | `15091` | `evidence/full_training_preflight/training_inputs_report.json` |
| `alberta_manifest` | `False` | `0` | `checkpoints/asimov_1_alberta_full/manifest.json` |
| `alberta_policy` | `False` | `0` | `checkpoints/asimov_1_alberta_full/alberta_policy.npz` |
| `backend_comparison_json` | `False` | `0` | `evidence/backend_compare/asimov-1/comparison.json` |
| `backend_comparison_md` | `False` | `0` | `evidence/backend_compare/asimov-1/comparison.md` |
| `joint_reach_benchmark_json` | `False` | `0` | `evidence/alberta_joint_reach/continual_benchmark.json` |
| `joint_reach_benchmark_md` | `False` | `0` | `evidence/alberta_joint_reach/continual_benchmark.md` |
| `joint_reach_benchmark_plot` | `False` | `0` | `evidence/alberta_joint_reach/continual_benchmark.png` |
| `obstacle_course_benchmark_json` | `False` | `0` | `evidence/alberta_obstacle_course/continual_benchmark.json` |
| `obstacle_course_benchmark_md` | `False` | `0` | `evidence/alberta_obstacle_course/continual_benchmark.md` |
| `obstacle_course_benchmark_plot` | `False` | `0` | `evidence/alberta_obstacle_course/continual_benchmark.png` |
| `brax_manifest` | `False` | `0` | `evidence/full_training_preflight/asimov_1_brax_mjx_baseline/manifest.json` |
| `brax_policy` | `False` | `0` | `evidence/full_training_preflight/asimov_1_brax_mjx_baseline/policy_brax.pkl` |
| `agent_video_manifest` | `True` | `5338` | `evidence/agent_videos/manifest.json` |
| `production_video_asimov_stand_up` | `True` | `94772` | `evidence/agent_videos/asimov-1/asimov-1_stand_up.mp4` |
| `production_video_asimov_walk_forward` | `True` | `113237` | `evidence/agent_videos/asimov-1/asimov-1_walk_forward.mp4` |
| `production_video_asimov_turn_left` | `True` | `45524` | `evidence/agent_videos/asimov-1/asimov-1_turn_left.mp4` |
| `production_video_asimov_turn_right` | `True` | `34826` | `evidence/agent_videos/asimov-1/asimov-1_turn_right.mp4` |
| `production_video_asimov_combined` | `True` | `211794` | `evidence/agent_videos/asimov-1/asimov-1_combined_actions.mp4` |
| `multi_robot_video_hiwonder_stand_up` | `True` | `78058` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_stand_up.mp4` |
| `multi_robot_video_hiwonder_walk_forward` | `True` | `51239` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.mp4` |
| `multi_robot_video_hiwonder_turn_left` | `True` | `39420` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_left.mp4` |
| `multi_robot_video_hiwonder_turn_right` | `True` | `34666` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_right.mp4` |
| `multi_robot_video_hiwonder_combined` | `True` | `148177` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.mp4` |
| `multi_robot_video_unitree_g1_stand_up` | `True` | `78170` | `evidence/agent_videos/unitree-g1/unitree-g1_stand_up.mp4` |
| `multi_robot_video_unitree_g1_walk_forward` | `True` | `73066` | `evidence/agent_videos/unitree-g1/unitree-g1_walk_forward.mp4` |
| `multi_robot_video_unitree_g1_turn_left` | `True` | `64537` | `evidence/agent_videos/unitree-g1/unitree-g1_turn_left.mp4` |
| `multi_robot_video_unitree_g1_turn_right` | `True` | `69347` | `evidence/agent_videos/unitree-g1/unitree-g1_turn_right.mp4` |
| `multi_robot_video_unitree_g1_combined` | `True` | `221028` | `evidence/agent_videos/unitree-g1/unitree-g1_combined_actions.mp4` |
| `multi_robot_video_unitree_h1_stand_up` | `True` | `174683` | `evidence/agent_videos/unitree-h1/unitree-h1_stand_up.mp4` |
| `multi_robot_video_unitree_h1_walk_forward` | `True` | `74573` | `evidence/agent_videos/unitree-h1/unitree-h1_walk_forward.mp4` |
| `multi_robot_video_unitree_h1_turn_left` | `True` | `46164` | `evidence/agent_videos/unitree-h1/unitree-h1_turn_left.mp4` |
| `multi_robot_video_unitree_h1_turn_right` | `True` | `45803` | `evidence/agent_videos/unitree-h1/unitree-h1_turn_right.mp4` |
| `multi_robot_video_unitree_h1_combined` | `True` | `288273` | `evidence/agent_videos/unitree-h1/unitree-h1_combined_actions.mp4` |
| `multi_robot_video_unitree_r1_stand_up` | `False` | `0` | `evidence/agent_videos/unitree-r1/unitree-r1_stand_up.mp4` |
| `multi_robot_video_unitree_r1_walk_forward` | `False` | `0` | `evidence/agent_videos/unitree-r1/unitree-r1_walk_forward.mp4` |
| `multi_robot_video_unitree_r1_turn_left` | `False` | `0` | `evidence/agent_videos/unitree-r1/unitree-r1_turn_left.mp4` |
| `multi_robot_video_unitree_r1_turn_right` | `False` | `0` | `evidence/agent_videos/unitree-r1/unitree-r1_turn_right.mp4` |
| `multi_robot_video_unitree_r1_combined` | `False` | `0` | `evidence/agent_videos/unitree-r1/unitree-r1_combined_actions.mp4` |
| `production_video_review` | `True` | `21564` | `evidence/video_review_production/video_review.json` |
| `production_video_contact_asimov_stand_up` | `True` | `80976` | `evidence/video_review_production/asimov-1_asimov-1_stand_up_contact.jpg` |
| `production_video_contact_asimov_walk_forward` | `True` | `80739` | `evidence/video_review_production/asimov-1_asimov-1_walk_forward_contact.jpg` |
| `production_video_contact_asimov_turn_left` | `True` | `77346` | `evidence/video_review_production/asimov-1_asimov-1_turn_left_contact.jpg` |
| `production_video_contact_asimov_turn_right` | `True` | `77231` | `evidence/video_review_production/asimov-1_asimov-1_turn_right_contact.jpg` |
| `production_video_contact_asimov_combined` | `True` | `78895` | `evidence/video_review_production/asimov-1_asimov-1_combined_actions_contact.jpg` |
| `multi_robot_contact_hiwonder_stand_up` | `True` | `41802` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_stand_up_contact.jpg` |
| `multi_robot_contact_hiwonder_walk_forward` | `True` | `41813` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_walk_forward_contact.jpg` |
| `multi_robot_contact_hiwonder_turn_left` | `True` | `41744` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_turn_left_contact.jpg` |
| `multi_robot_contact_hiwonder_turn_right` | `True` | `41748` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_turn_right_contact.jpg` |
| `multi_robot_contact_hiwonder_combined` | `True` | `41897` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_combined_actions_contact.jpg` |
| `multi_robot_contact_unitree_g1_stand_up` | `True` | `65100` | `evidence/video_review_production/unitree-g1_unitree-g1_stand_up_contact.jpg` |
| `multi_robot_contact_unitree_g1_walk_forward` | `True` | `65040` | `evidence/video_review_production/unitree-g1_unitree-g1_walk_forward_contact.jpg` |
| `multi_robot_contact_unitree_g1_turn_left` | `True` | `65154` | `evidence/video_review_production/unitree-g1_unitree-g1_turn_left_contact.jpg` |
| `multi_robot_contact_unitree_g1_turn_right` | `True` | `65049` | `evidence/video_review_production/unitree-g1_unitree-g1_turn_right_contact.jpg` |
| `multi_robot_contact_unitree_g1_combined` | `True` | `64991` | `evidence/video_review_production/unitree-g1_unitree-g1_combined_actions_contact.jpg` |
| `multi_robot_contact_unitree_h1_stand_up` | `True` | `69040` | `evidence/video_review_production/unitree-h1_unitree-h1_stand_up_contact.jpg` |
| `multi_robot_contact_unitree_h1_walk_forward` | `True` | `65903` | `evidence/video_review_production/unitree-h1_unitree-h1_walk_forward_contact.jpg` |
| `multi_robot_contact_unitree_h1_turn_left` | `True` | `65756` | `evidence/video_review_production/unitree-h1_unitree-h1_turn_left_contact.jpg` |
| `multi_robot_contact_unitree_h1_turn_right` | `True` | `65615` | `evidence/video_review_production/unitree-h1_unitree-h1_turn_right_contact.jpg` |
| `multi_robot_contact_unitree_h1_combined` | `True` | `66983` | `evidence/video_review_production/unitree-h1_unitree-h1_combined_actions_contact.jpg` |
| `multi_robot_contact_unitree_r1_stand_up` | `False` | `0` | `evidence/video_review_production/unitree-r1_unitree-r1_stand_up_contact.jpg` |
| `multi_robot_contact_unitree_r1_walk_forward` | `False` | `0` | `evidence/video_review_production/unitree-r1_unitree-r1_walk_forward_contact.jpg` |
| `multi_robot_contact_unitree_r1_turn_left` | `False` | `0` | `evidence/video_review_production/unitree-r1_unitree-r1_turn_left_contact.jpg` |
| `multi_robot_contact_unitree_r1_turn_right` | `False` | `0` | `evidence/video_review_production/unitree-r1_unitree-r1_turn_right_contact.jpg` |
| `multi_robot_contact_unitree_r1_combined` | `False` | `0` | `evidence/video_review_production/unitree-r1_unitree-r1_combined_actions_contact.jpg` |
| `monitor_status` | `True` | `6851` | `monitor_status.json` |
| `monitor_summary` | `True` | `915` | `monitor_summary.md` |
| `validation_report` | `True` | `49639` | `validation_report.json` |
| `validation_summary` | `True` | `2292` | `validation_summary.md` |
| `finalization_report` | `True` | `3397` | `finalization_report.json` |
| `finalization_summary` | `True` | `2251` | `finalization_summary.md` |
| `training_comparison_report` | `True` | `23140` | `training_comparison_report.json` |
| `training_comparison_summary` | `True` | `8463` | `training_comparison_report.md` |
| `alberta_end_to_end_report_json` | `True` | `2859` | `evidence/ALBERTA_END_TO_END_REPORT.json` |
| `alberta_end_to_end_report_md` | `True` | `1132` | `evidence/ALBERTA_END_TO_END_REPORT.md` |
| `runtime_watch_history` | `True` | `10414` | `runtime_watch_history.jsonl` |
| `instance_launch_hygiene` | `True` | `1207` | `instance_launch_hygiene.json` |
