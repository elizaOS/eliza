# Nebius Full Training Closeout

Run: `robot-full-1779504720`
State: `running`
Closeout ok: `False`
Observed: `2026-05-23T17:02:58.019424Z`

## Chain Results

- monitor: `running` / ok=`False`
- finalization: ok=`False`
- training report: ok=`False`
- objective audit: ok=`False`

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
- `artifact_inventory`

## Artifacts

- monitor: `evidence/nebius_full_training/synced_run/monitor_status.json`
- validation: `evidence/nebius_full_training/synced_run/validation_report.json`
- finalization: `evidence/nebius_full_training/synced_run/finalization_report.json`
- training report: `evidence/nebius_full_training/synced_run/training_comparison_report.json`
- artifact inventory: `{'ok': False, 'present_count': 53, 'required_count': 88, 'missing': ['status_success', 'runner_status', 'status_00_local_preflight', 'status_10_nebius_train_alberta', 'status_20_nebius_compare_backends', 'status_30_nebius_continual_benchmarks', 'status_40_nebius_brax_baseline', 'status_50_post_train_validation', 'log_train_alberta', 'log_compare_backends', 'log_continual_benchmarks', 'log_brax_baseline', 'log_post_train_validation', 'alberta_manifest', 'alberta_policy', 'backend_comparison_json', 'backend_comparison_md', 'joint_reach_benchmark_json', 'joint_reach_benchmark_md', 'joint_reach_benchmark_plot', 'obstacle_course_benchmark_json', 'obstacle_course_benchmark_md', 'obstacle_course_benchmark_plot', 'brax_manifest', 'brax_policy', 'multi_robot_video_unitree_r1_stand_up', 'multi_robot_video_unitree_r1_walk_forward', 'multi_robot_video_unitree_r1_turn_left', 'multi_robot_video_unitree_r1_turn_right', 'multi_robot_video_unitree_r1_combined', 'multi_robot_contact_unitree_r1_stand_up', 'multi_robot_contact_unitree_r1_walk_forward', 'multi_robot_contact_unitree_r1_turn_left', 'multi_robot_contact_unitree_r1_turn_right', 'multi_robot_contact_unitree_r1_combined']}`
- objective audit: `evidence/nebius_full_training/synced_run/objective_completion_audit.json`
