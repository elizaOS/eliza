# Nebius Training Artifact Inventory

Result: `incomplete`
Present: `107` / `117`
Generated: `2026-05-24T07:27:27.132251Z`

## Category Summary

| category | present | required | missing |
|---|---:|---:|---|
| `backend_comparison` | `2` | `2` | `none` |
| `checkpoints` | `4` | `4` | `none` |
| `continual_benchmarks` | `6` | `6` | `none` |
| `review_reports` | `2` | `12` | `monitor_status, monitor_summary, validation_report, validation_summary, finalization_report, finalization_summary, training_comparison_report, training_comparison_summary, runtime_watch_history, instance_launch_hygiene` |
| `stage_status` | `13` | `13` | `none` |
| `training_inputs` | `2` | `2` | `none` |
| `video_evidence` | `78` | `78` | `none` |

## Artifact Detail

| artifact | present | bytes | path |
|---|---:|---:|---|
| `status_success` | `True` | `36` | `status/success.txt` |
| `runner_status` | `True` | `6253` | `status/runner_status.json` |
| `status_00_local_preflight` | `True` | `4030` | `status/00_local_preflight.json` |
| `status_10_nebius_train_alberta` | `True` | `2926` | `status/10_nebius_train_alberta.json` |
| `status_20_nebius_compare_backends` | `True` | `3876` | `status/20_nebius_compare_backends.json` |
| `status_30_nebius_continual_benchmarks` | `True` | `3784` | `status/30_nebius_continual_benchmarks.json` |
| `status_40_nebius_brax_baseline` | `True` | `3508` | `status/40_nebius_brax_baseline.json` |
| `status_50_post_train_validation` | `True` | `3862` | `status/50_post_train_validation.json` |
| `log_train_alberta` | `True` | `2323` | `logs/10_nebius_train_alberta.log` |
| `log_compare_backends` | `True` | `130201` | `logs/20_nebius_compare_backends.log` |
| `log_continual_benchmarks` | `True` | `5943` | `logs/30_nebius_continual_benchmarks.log` |
| `log_brax_baseline` | `True` | `50486` | `logs/40_nebius_brax_baseline.log` |
| `log_post_train_validation` | `True` | `144443` | `logs/50_post_train_validation.log` |
| `training_inputs_report` | `True` | `14836` | `evidence/full_training_preflight/training_inputs_report.json` |
| `alberta_manifest` | `True` | `2897` | `checkpoints/asimov_1_alberta_full/manifest.json` |
| `alberta_policy` | `True` | `261226` | `checkpoints/asimov_1_alberta_full/alberta_policy.npz` |
| `backend_comparison_json` | `True` | `18408` | `evidence/backend_compare/asimov-1/comparison.json` |
| `backend_comparison_md` | `True` | `1605` | `evidence/backend_compare/asimov-1/comparison.md` |
| `joint_reach_benchmark_json` | `True` | `9389` | `evidence/alberta_joint_reach/continual_benchmark.json` |
| `joint_reach_benchmark_md` | `True` | `1427` | `evidence/alberta_joint_reach/continual_benchmark.md` |
| `joint_reach_benchmark_plot` | `True` | `53074` | `evidence/alberta_joint_reach/continual_benchmark.png` |
| `obstacle_course_benchmark_json` | `True` | `9506` | `evidence/alberta_obstacle_course/continual_benchmark.json` |
| `obstacle_course_benchmark_md` | `True` | `1422` | `evidence/alberta_obstacle_course/continual_benchmark.md` |
| `obstacle_course_benchmark_plot` | `True` | `49794` | `evidence/alberta_obstacle_course/continual_benchmark.png` |
| `obstacle_course_demo_json` | `True` | `5810` | `evidence/alberta_obstacle_course/obstacle_course_demo.json` |
| `obstacle_course_demo_video` | `True` | `112704` | `evidence/alberta_obstacle_course/obstacle_course_demo.mp4` |
| `brax_manifest` | `True` | `1432` | `evidence/full_training_preflight/asimov_1_brax_mjx_baseline/manifest.json` |
| `brax_policy` | `True` | `1626932` | `evidence/full_training_preflight/asimov_1_brax_mjx_baseline/policy_brax.pkl` |
| `agent_video_manifest` | `True` | `7851` | `evidence/agent_videos/manifest.json` |
| `production_video_asimov_stand_up` | `True` | `348504` | `evidence/agent_videos/asimov-1/asimov-1_stand_up.mp4` |
| `production_video_asimov_walk_forward` | `True` | `341035` | `evidence/agent_videos/asimov-1/asimov-1_walk_forward.mp4` |
| `production_video_asimov_turn_left` | `True` | `340159` | `evidence/agent_videos/asimov-1/asimov-1_turn_left.mp4` |
| `production_video_asimov_turn_right` | `True` | `340317` | `evidence/agent_videos/asimov-1/asimov-1_turn_right.mp4` |
| `production_video_asimov_combined` | `True` | `1134208` | `evidence/agent_videos/asimov-1/asimov-1_combined_actions.mp4` |
| `production_video_telemetry_asimov_stand_up` | `True` | `1516` | `evidence/agent_videos/asimov-1/asimov-1_stand_up.telemetry.json` |
| `production_video_telemetry_asimov_walk_forward` | `True` | `1522` | `evidence/agent_videos/asimov-1/asimov-1_walk_forward.telemetry.json` |
| `production_video_telemetry_asimov_turn_left` | `True` | `1519` | `evidence/agent_videos/asimov-1/asimov-1_turn_left.telemetry.json` |
| `production_video_telemetry_asimov_turn_right` | `True` | `1514` | `evidence/agent_videos/asimov-1/asimov-1_turn_right.telemetry.json` |
| `production_video_telemetry_asimov_combined` | `True` | `7456` | `evidence/agent_videos/asimov-1/asimov-1_combined_actions.telemetry.json` |
| `multi_robot_video_hiwonder_stand_up` | `True` | `164953` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_stand_up.mp4` |
| `multi_robot_video_hiwonder_walk_forward` | `True` | `218059` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.mp4` |
| `multi_robot_video_hiwonder_turn_left` | `True` | `201997` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_left.mp4` |
| `multi_robot_video_hiwonder_turn_right` | `True` | `190451` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_right.mp4` |
| `multi_robot_video_hiwonder_combined` | `True` | `646287` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.mp4` |
| `multi_robot_video_telemetry_hiwonder_stand_up` | `True` | `1428` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_stand_up.telemetry.json` |
| `multi_robot_video_telemetry_hiwonder_walk_forward` | `True` | `1498` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.telemetry.json` |
| `multi_robot_video_telemetry_hiwonder_turn_left` | `True` | `1491` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_left.telemetry.json` |
| `multi_robot_video_telemetry_hiwonder_turn_right` | `True` | `1495` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_right.telemetry.json` |
| `multi_robot_video_telemetry_hiwonder_combined` | `True` | `7272` | `evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.telemetry.json` |
| `multi_robot_video_unitree_g1_stand_up` | `True` | `128966` | `evidence/agent_videos/unitree-g1/unitree-g1_stand_up.mp4` |
| `multi_robot_video_unitree_g1_walk_forward` | `True` | `381460` | `evidence/agent_videos/unitree-g1/unitree-g1_walk_forward.mp4` |
| `multi_robot_video_unitree_g1_turn_left` | `True` | `334958` | `evidence/agent_videos/unitree-g1/unitree-g1_turn_left.mp4` |
| `multi_robot_video_unitree_g1_turn_right` | `True` | `334380` | `evidence/agent_videos/unitree-g1/unitree-g1_turn_right.mp4` |
| `multi_robot_video_unitree_g1_combined` | `True` | `1001805` | `evidence/agent_videos/unitree-g1/unitree-g1_combined_actions.mp4` |
| `multi_robot_video_telemetry_unitree_g1_stand_up` | `True` | `1420` | `evidence/agent_videos/unitree-g1/unitree-g1_stand_up.telemetry.json` |
| `multi_robot_video_telemetry_unitree_g1_walk_forward` | `True` | `1494` | `evidence/agent_videos/unitree-g1/unitree-g1_walk_forward.telemetry.json` |
| `multi_robot_video_telemetry_unitree_g1_turn_left` | `True` | `1483` | `evidence/agent_videos/unitree-g1/unitree-g1_turn_left.telemetry.json` |
| `multi_robot_video_telemetry_unitree_g1_turn_right` | `True` | `1486` | `evidence/agent_videos/unitree-g1/unitree-g1_turn_right.telemetry.json` |
| `multi_robot_video_telemetry_unitree_g1_combined` | `True` | `7239` | `evidence/agent_videos/unitree-g1/unitree-g1_combined_actions.telemetry.json` |
| `multi_robot_video_unitree_h1_stand_up` | `True` | `376393` | `evidence/agent_videos/unitree-h1/unitree-h1_stand_up.mp4` |
| `multi_robot_video_unitree_h1_walk_forward` | `True` | `383955` | `evidence/agent_videos/unitree-h1/unitree-h1_walk_forward.mp4` |
| `multi_robot_video_unitree_h1_turn_left` | `True` | `382225` | `evidence/agent_videos/unitree-h1/unitree-h1_turn_left.mp4` |
| `multi_robot_video_unitree_h1_turn_right` | `True` | `379190` | `evidence/agent_videos/unitree-h1/unitree-h1_turn_right.mp4` |
| `multi_robot_video_unitree_h1_combined` | `True` | `1417076` | `evidence/agent_videos/unitree-h1/unitree-h1_combined_actions.mp4` |
| `multi_robot_video_telemetry_unitree_h1_stand_up` | `True` | `1421` | `evidence/agent_videos/unitree-h1/unitree-h1_stand_up.telemetry.json` |
| `multi_robot_video_telemetry_unitree_h1_walk_forward` | `True` | `1495` | `evidence/agent_videos/unitree-h1/unitree-h1_walk_forward.telemetry.json` |
| `multi_robot_video_telemetry_unitree_h1_turn_left` | `True` | `1485` | `evidence/agent_videos/unitree-h1/unitree-h1_turn_left.telemetry.json` |
| `multi_robot_video_telemetry_unitree_h1_turn_right` | `True` | `1487` | `evidence/agent_videos/unitree-h1/unitree-h1_turn_right.telemetry.json` |
| `multi_robot_video_telemetry_unitree_h1_combined` | `True` | `7244` | `evidence/agent_videos/unitree-h1/unitree-h1_combined_actions.telemetry.json` |
| `multi_robot_video_unitree_r1_stand_up` | `True` | `273896` | `evidence/agent_videos/unitree-r1/unitree-r1_stand_up.mp4` |
| `multi_robot_video_unitree_r1_walk_forward` | `True` | `310123` | `evidence/agent_videos/unitree-r1/unitree-r1_walk_forward.mp4` |
| `multi_robot_video_unitree_r1_turn_left` | `True` | `323916` | `evidence/agent_videos/unitree-r1/unitree-r1_turn_left.mp4` |
| `multi_robot_video_unitree_r1_turn_right` | `True` | `320459` | `evidence/agent_videos/unitree-r1/unitree-r1_turn_right.mp4` |
| `multi_robot_video_unitree_r1_combined` | `True` | `1029188` | `evidence/agent_videos/unitree-r1/unitree-r1_combined_actions.mp4` |
| `multi_robot_video_telemetry_unitree_r1_stand_up` | `True` | `1422` | `evidence/agent_videos/unitree-r1/unitree-r1_stand_up.telemetry.json` |
| `multi_robot_video_telemetry_unitree_r1_walk_forward` | `True` | `1495` | `evidence/agent_videos/unitree-r1/unitree-r1_walk_forward.telemetry.json` |
| `multi_robot_video_telemetry_unitree_r1_turn_left` | `True` | `1487` | `evidence/agent_videos/unitree-r1/unitree-r1_turn_left.telemetry.json` |
| `multi_robot_video_telemetry_unitree_r1_turn_right` | `True` | `1487` | `evidence/agent_videos/unitree-r1/unitree-r1_turn_right.telemetry.json` |
| `multi_robot_video_telemetry_unitree_r1_combined` | `True` | `7247` | `evidence/agent_videos/unitree-r1/unitree-r1_combined_actions.telemetry.json` |
| `production_video_review` | `True` | `54801` | `evidence/video_review_production/video_review.json` |
| `production_video_contact_asimov_stand_up` | `True` | `94982` | `evidence/video_review_production/asimov-1_asimov-1_stand_up_contact.jpg` |
| `production_video_contact_asimov_walk_forward` | `True` | `94975` | `evidence/video_review_production/asimov-1_asimov-1_walk_forward_contact.jpg` |
| `production_video_contact_asimov_turn_left` | `True` | `95013` | `evidence/video_review_production/asimov-1_asimov-1_turn_left_contact.jpg` |
| `production_video_contact_asimov_turn_right` | `True` | `94931` | `evidence/video_review_production/asimov-1_asimov-1_turn_right_contact.jpg` |
| `production_video_contact_asimov_combined` | `True` | `94341` | `evidence/video_review_production/asimov-1_asimov-1_combined_actions_contact.jpg` |
| `multi_robot_contact_hiwonder_stand_up` | `True` | `42816` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_stand_up_contact.jpg` |
| `multi_robot_contact_hiwonder_walk_forward` | `True` | `43111` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_walk_forward_contact.jpg` |
| `multi_robot_contact_hiwonder_turn_left` | `True` | `42675` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_turn_left_contact.jpg` |
| `multi_robot_contact_hiwonder_turn_right` | `True` | `42840` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_turn_right_contact.jpg` |
| `multi_robot_contact_hiwonder_combined` | `True` | `42884` | `evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_combined_actions_contact.jpg` |
| `multi_robot_contact_unitree_g1_stand_up` | `True` | `72439` | `evidence/video_review_production/unitree-g1_unitree-g1_stand_up_contact.jpg` |
| `multi_robot_contact_unitree_g1_walk_forward` | `True` | `71994` | `evidence/video_review_production/unitree-g1_unitree-g1_walk_forward_contact.jpg` |
| `multi_robot_contact_unitree_g1_turn_left` | `True` | `72525` | `evidence/video_review_production/unitree-g1_unitree-g1_turn_left_contact.jpg` |
| `multi_robot_contact_unitree_g1_turn_right` | `True` | `72517` | `evidence/video_review_production/unitree-g1_unitree-g1_turn_right_contact.jpg` |
| `multi_robot_contact_unitree_g1_combined` | `True` | `72573` | `evidence/video_review_production/unitree-g1_unitree-g1_combined_actions_contact.jpg` |
| `multi_robot_contact_unitree_h1_stand_up` | `True` | `79544` | `evidence/video_review_production/unitree-h1_unitree-h1_stand_up_contact.jpg` |
| `multi_robot_contact_unitree_h1_walk_forward` | `True` | `79393` | `evidence/video_review_production/unitree-h1_unitree-h1_walk_forward_contact.jpg` |
| `multi_robot_contact_unitree_h1_turn_left` | `True` | `79426` | `evidence/video_review_production/unitree-h1_unitree-h1_turn_left_contact.jpg` |
| `multi_robot_contact_unitree_h1_turn_right` | `True` | `79458` | `evidence/video_review_production/unitree-h1_unitree-h1_turn_right_contact.jpg` |
| `multi_robot_contact_unitree_h1_combined` | `True` | `79154` | `evidence/video_review_production/unitree-h1_unitree-h1_combined_actions_contact.jpg` |
| `multi_robot_contact_unitree_r1_stand_up` | `True` | `74239` | `evidence/video_review_production/unitree-r1_unitree-r1_stand_up_contact.jpg` |
| `multi_robot_contact_unitree_r1_walk_forward` | `True` | `74221` | `evidence/video_review_production/unitree-r1_unitree-r1_walk_forward_contact.jpg` |
| `multi_robot_contact_unitree_r1_turn_left` | `True` | `74155` | `evidence/video_review_production/unitree-r1_unitree-r1_turn_left_contact.jpg` |
| `multi_robot_contact_unitree_r1_turn_right` | `True` | `74148` | `evidence/video_review_production/unitree-r1_unitree-r1_turn_right_contact.jpg` |
| `multi_robot_contact_unitree_r1_combined` | `True` | `74139` | `evidence/video_review_production/unitree-r1_unitree-r1_combined_actions_contact.jpg` |
| `monitor_status` | `False` | `0` | `monitor_status.json` |
| `monitor_summary` | `False` | `0` | `monitor_summary.md` |
| `validation_report` | `False` | `0` | `validation_report.json` |
| `validation_summary` | `False` | `0` | `validation_summary.md` |
| `finalization_report` | `False` | `0` | `finalization_report.json` |
| `finalization_summary` | `False` | `0` | `finalization_summary.md` |
| `training_comparison_report` | `False` | `0` | `training_comparison_report.json` |
| `training_comparison_summary` | `False` | `0` | `training_comparison_report.md` |
| `alberta_end_to_end_report_json` | `True` | `50537` | `evidence/ALBERTA_END_TO_END_REPORT.json` |
| `alberta_end_to_end_report_md` | `True` | `18952` | `evidence/ALBERTA_END_TO_END_REPORT.md` |
| `runtime_watch_history` | `False` | `0` | `runtime_watch_history.jsonl` |
| `instance_launch_hygiene` | `False` | `0` | `instance_launch_hygiene.json` |
