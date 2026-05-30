# Robot Motion And Learning Audit

Overall ok: `False`

## Findings

- Existing production robot videos prove physical walking/turning: `False`.
- Existing learned-policy curriculum eval proves task success and physical motion: `False`.
- Local short learning probe shows learned motion signal: `True`.
- Local short learning probe shows walking-grade learning signal: `False`.
- Local short learning probe reaches walking success: `False`.
- Open-loop task feasibility candidates can satisfy walking: `False`.
- Open-loop gait search finds a walking primitive: `False`.
- Random sine gait search finds a walking primitive: `False`.
- Stabilized near-gait search can hold walking: `False`.
- HiWonder near-gait visual artifact proves active motion: `True`.
- HiWonder near-gait visual artifact proves valid walking: `False`.
- Cross-profile walking evidence beats passive baselines: `False`.
- Existing Nebius obstacle-course evidence has benchmark rollout metrics: `False`.
- Fresh obstacle smoke 2D point-robot benchmark with path traces passes: `True`.
- Fresh obstacle smoke proves MuJoCo/real robot walking: `False`.

## Failed Production Video Motion Checks

| profile | action | failed checks |
|---|---|---|
| `asimov-1` | `combined_actions` | `telemetry_rollout_ok, telemetry_action_progress` |
| `asimov-1` | `sidestep_left` | `telemetry_rollout_ok` |
| `asimov-1` | `sidestep_right` | `telemetry_rollout_ok` |
| `asimov-1` | `turn_left` | `telemetry_rollout_ok, telemetry_action_progress` |
| `asimov-1` | `turn_right` | `telemetry_rollout_ok, telemetry_action_progress` |
| `asimov-1` | `walk_backward` | `telemetry_rollout_ok` |
| `asimov-1` | `walk_forward` | `telemetry_rollout_ok, telemetry_action_progress` |
| `hiwonder-ainex` | `combined_actions` | `telemetry_action_progress` |
| `hiwonder-ainex` | `turn_left` | `telemetry_action_progress` |
| `hiwonder-ainex` | `turn_right` | `telemetry_action_progress` |
| `hiwonder-ainex` | `walk_forward` | `telemetry_action_progress` |
| `unitree-g1` | `combined_actions` | `telemetry_action_progress` |
| `unitree-g1` | `turn_left` | `telemetry_action_progress` |
| `unitree-g1` | `turn_right` | `telemetry_action_progress` |
| `unitree-g1` | `walk_forward` | `telemetry_action_progress` |
| `unitree-h1` | `combined_actions` | `telemetry_action_progress` |
| `unitree-h1` | `turn_left` | `telemetry_action_progress` |
| `unitree-h1` | `turn_right` | `telemetry_action_progress` |
| `unitree-h1` | `walk_forward` | `telemetry_action_progress` |
| `unitree-r1` | `combined_actions` | `telemetry_action_progress` |
| `unitree-r1` | `turn_left` | `telemetry_action_progress` |
| `unitree-r1` | `turn_right` | `telemetry_action_progress` |
| `unitree-r1` | `walk_forward` | `telemetry_action_progress` |

## Learned Policy Curriculum Eval

Programmatic pass rate: `0.0`

| task | failed physical checks | success rate |
|---|---|---:|
| `stand_up` | `none` | 0.00 |
| `walk_forward` | `none` | 0.00 |
| `walk_backward` | `none` | 0.00 |
| `sidestep_left` | `none` | 0.00 |
| `sidestep_right` | `none` | 0.00 |
| `turn_left` | `none` | 0.00 |
| `turn_right` | `none` | 0.00 |

## Local Learning Probe

Probe ok as walking evidence: `False`
Verdict: `stable_forward_shuffle_below_distance_after_scale015_fall100_8k`
Learned motion signal: `True`
Walking-grade learning signal: `False`
Trained is falling lunge: `False`
Trained is backward fall: `False`
Trained is stable standstill: `False`
Trained has no forward motion: `False`
Trained has alternating contacts: `False`
Trained is partial stepping below distance: `False`
Trained is stable forward shuffle below distance: `True`
Reward delta trained-zero: `425.10796818611345`
Forward delta trained-zero m: `0.06448205955488585`
Tracked forward delta trained m: `0.06507441489015495`
Trained failure rate: `0.0`
Trained yaw drift rad: `0.17410843586368616`
Promotion blocker: `phase_success_rate_below_threshold`

## Local Prior Residual Probes

| source | ctrl | scale | mode | walking | learned motion | reward delta | tracked dx m | failure rate | failed gates | prior max | residual pre/post | residual guard | residual scale | contacts | verdict |
|---|---|---:|---|---|---|---:|---:|---:|---|---:|---:|---:|---:|---|---|
| `local_learning_probe_hiwonder_sine_prior_residual_scale025_6k` | `linear` | 0.200 | `missing` | `False` | `False` | 625.3 | 0.007 | 0.00 | `tracked_delta_x_forward, min_swing_foot_clearance_m, hold_s` | 0.000 | 0.000 / 0.000 | 0.000 | 0.000 | `4.0` | `partial_stepping_below_distance_after_scale030_8k` |
| `local_learning_probe_hiwonder_sine_prior_scale0699_residual015_6k` | `linear` | 0.699 | `missing` | `False` | `False` | -360.8 | 0.148 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, max_foot_slip_m_s, max_self_collision_count, no_fall, hold_s` | 0.000 | 0.000 / 0.000 | 0.000 | 0.000 | `4.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_sine_prior_only_diagnostic` | `linear` | 0.200 | `missing` | `False` | `False` | 0.0 | 0.137 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, no_fall, hold_s` | 0.585 | 0.000 / 0.000 | 0.000 | 0.000 | `3.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_sine_prior_progress_coupled_scale025_3k` | `linear` | 0.200 | `missing` | `False` | `False` | -396.8 | -0.001 | 0.00 | `tracked_delta_x_forward, yaw_drift_bound, hold_s` | 0.576 | 0.400 / 0.065 | 0.163 | 0.250 | `6.0` | `no_forward_motion_after_progress_8k` |
| `local_learning_probe_hiwonder_stride_mod_3k` | `linear` | 0.200 | `hiwonder_stride_mod` | `False` | `False` | -11.4 | 0.136 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, no_fall, hold_s` | 0.669 | 0.027 / 0.003 | 0.227 | 1.000 | `3.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_stride_mod_scale1_3k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 76.1 | 0.166 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, max_foot_slip_m_s, max_self_collision_count, no_fall, hold_s` | 0.681 | 0.050 / 0.047 | 0.935 | 1.000 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_stride_mod_cbp_scale1_5k` | `cbp` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | -84.4 | 0.169 | 1.00 | `tracked_delta_x_forward, max_self_collision_count, no_fall, hold_s, min_alternating_foot_contacts` | 0.646 | 0.034 / 0.031 | 0.910 | 1.000 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_stride_mod_named_scale1_5k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 53.8 | 0.166 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, max_foot_slip_m_s, max_self_collision_count, no_fall, hold_s` | 0.662 | 0.018 / 0.016 | 0.908 | 1.000 | `4.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_stride_mod_named_scale0815_5k` | `linear` | 0.815 | `hiwonder_stride_mod` | `False` | `False` | 7.4 | 0.163 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, max_foot_slip_m_s, max_self_collision_count, no_fall, hold_s` | 0.665 | 0.041 / 0.039 | 0.929 | 1.000 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_collision_safe_stride_mod_scale1_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 3.3 | 0.246 | 1.00 | `tracked_delta_x_forward, no_fall, hold_s, min_alternating_foot_contacts` | 0.708 | 0.029 / 0.025 | 0.906 | 1.000 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_collision_safe_sagittal_stride_mod_scale1_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | -994.5 | 0.166 | 1.00 | `tracked_delta_x_forward, max_self_collision_count, no_fall, hold_s, min_alternating_foot_contacts` | 0.583 | 0.025 / 0.024 | 0.955 | 1.000 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_collision_safe_sagittal_stride_mod_resid025_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | -4.5 | 0.296 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, no_fall, hold_s, min_alternating_foot_contacts` | 0.670 | 0.024 / 0.022 | 0.933 | 0.250 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_collision_safe_sagittal_stride_mod_resid025_yaw055_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 4.4 | 0.301 | 1.00 | `yaw_drift_bound, no_fall, hold_s, min_alternating_foot_contacts` | 0.673 | 0.021 / 0.019 | 0.939 | 0.250 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_honest_stride_mod_resid025_yaw055_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | -0.0 | 0.284 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, max_foot_slip_m_s, no_fall, hold_s, min_alternating_foot_contacts` | 0.689 | 0.017 / 0.016 | 0.954 | 0.250 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_cadence_honest_stride_mod_resid025_yaw055_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | -2.7 | 0.262 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, no_fall, hold_s, min_alternating_foot_contacts` | 0.671 | 0.021 / 0.019 | 0.944 | 0.250 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contract_honest_stride_mod_resid025_yaw055_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | -3.4 | 0.302 | 1.00 | `yaw_drift_bound, max_foot_slip_m_s, no_fall, hold_s, min_alternating_foot_contacts` | 0.675 | 0.018 / 0.017 | 0.946 | 0.250 | `1.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_stride_mod_resid025_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 5.2 | 0.268 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.611 | 0.024 / 0.023 | 0.935 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_stride_mod_resid050_seed27_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 3.9 | 0.259 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.616 | 0.016 / 0.016 | 0.955 | 0.500 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_no_progress_honest_resid025_seed28_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 2.4 | 0.282 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.628 | 0.017 / 0.016 | 0.936 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_active_prior_reward_resid025_seed29_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 4.4 | 0.269 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.617 | 0.036 / 0.035 | 0.944 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_max_slip_aligned_resid025_seed30_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 2.3 | 0.285 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.632 | 0.028 / 0.026 | 0.936 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_hold_taper_support_resid025_seed31_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 19.4 | 0.275 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.596 | 0.039 / 0.036 | 0.936 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_terminal_support_resid025_seed32_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 22.9 | 0.208 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, no_fall, hold_s` | 0.611 | 0.033 / 0.033 | 1.000 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_contact_sine_terminal_support_evalsplit_resid025_seed33_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 17.2 | 0.228 | 1.00 | `tracked_delta_x_forward, max_foot_slip_m_s, hold_s` | 0.631 | 0.020 / 0.020 | 1.000 | 0.250 | `2.0` | `not_walking_after_progress_8k` |
| `local_learning_probe_hiwonder_collision_safe_sagittal_stride_mod_resid025_pitch3_yaw075_8k` | `linear` | 1.000 | `hiwonder_stride_mod` | `False` | `False` | 167.5 | 0.118 | 1.00 | `tracked_delta_x_forward, yaw_drift_bound, max_self_collision_count, no_fall, hold_s` | 0.578 | 0.026 / 0.023 | 0.897 | 0.250 | `2.0` | `not_walking_after_progress_8k` |

## Open-loop Task Feasibility

Feasibility ok: `False`
Profile: `hiwonder-ainex`

| task | best controller | best dx m | best-progress controller | progress | dx m | dy m | hold s | termination | unmet predicates |
|---|---|---:|---|---:|---:|---:|---:|---|---|
| `walk_forward` | `deterministic_smoke` | 0.144 | `bezier_profile` | 0.54 | 0.162 | -0.001 | 0.00 | `fall` | `torso_z_min_ratio, delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `walk_backward` | `deterministic_smoke` | 0.001 | `motion_clip` | 0.23 | -0.046 | 0.000 | 0.00 | `fall` | `delta_x_m_max, no_fall, min_alternating_foot_contacts, min_swing_foot_clearance_m, hold_s` |
| `sidestep_left` | `deterministic_smoke` | 0.002 | `deterministic_wide` | 0.84 | 0.002 | 0.168 | 0.00 | `fall` | `delta_y_m_min, no_fall, min_alternating_foot_contacts, max_self_collision_count, hold_s` |
| `sidestep_right` | `deterministic_smoke` | 0.003 | `hiwonder_closed_loop_progress_settle` | 0.84 | 0.002 | -0.168 | 0.00 | `fall` | `delta_y_m_max, no_fall, min_alternating_foot_contacts, max_self_collision_count, hold_s` |

## Open-loop Gait Search

Search ok: `False`
Candidates: `15`

| criterion | controller | final dx m | peak dx m | termination | reason |
|---|---|---:|---:|---|---|
| best score | `sinusoidal_seeded_2` | 0.033 | 0.112 | `time_limit` | `none` |
| best forward | `sinusoidal_seeded_4` | 0.283 | 0.283 | `fall` | `fall: |pitch|=0.61 > 0.6` |
| best peak forward | `sinusoidal_seeded_4` | 0.283 | 0.283 | `fall` | `fall: |pitch|=0.61 > 0.6` |
| best stable peak forward | `sinusoidal_seeded_3` | 0.127 | 0.134 | `time_limit` | `none` |

Failure frontier:
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall candidates: `0`
- forward + straight candidates: `0`
- forward + no-fall + straight candidates: `0`

## Random Sine Gait Search

Search ok: `False`
Candidates: `240`
Successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
Local refinement:
- base controller: `random_sine_013`
- candidates: `220`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
Transition refinement:
- base controller: `local_random_sine_013_045`
- candidates: `144`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `transition_local_random_sine_013_045_000`
- best success window s: `0.0`
- best success-window dx m: `0.21941821561754388`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, no_fall, min_alternating_foot_contacts, max_foot_slip_m_s, hold_s`
Feedback refinement:
- base controller: `local_random_sine_013_045`
- candidates: `501`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `feedback_local_random_sine_013_045_093`
- best success window s: `0.0`
- best success-window dx m: `0.28196318150394`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, no_fall, max_foot_slip_m_s, hold_s`
Hybrid recovery refinement:
- base controller: `feedback_local_random_sine_013_045_093`
- candidates: `1004`
- successes: `0`
- primary gap: `stability`
- forward-displacement candidates: `3`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `hybrid_feedback_local_random_sine_013_045_093_1000`
- best success window s: `0.0`
- best success-window dx m: `0.3382670640894683`
- best success-window failure: `torso_z_min_ratio, no_fall, max_foot_slip_m_s, hold_s`
- best physical-gates controller: `hybrid_feedback_local_random_sine_013_045_093_1003`
- best physical-gates dx m: `0.08117556345991897`
- best physical-gates torso z m: `0.23790313472898644`
- best physical-gates max foot slip m/s: `0.2888130247592926`
- best physical-gates failure: `delta_x_m_min, hold_s`
Stable bridge refinement:
- base controller: `hybrid_feedback_local_random_sine_013_045_093_1003`
- candidates: `168`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best stable-bridge controller: `stable_bridge_hybrid_feedback_local_random_sine_013_045_093_1003_044`
- best stable-bridge dx m: `0.2293022035504783`
- best stable-bridge torso z m: `0.19238435490258857`
- best stable-bridge max foot slip m/s: `0.33737313747406006`
- best stable-bridge failure: `delta_x_m_min, no_fall, hold_s`
- best physical-gates controller: `stable_bridge_hybrid_feedback_local_random_sine_013_045_093_1003_014`
- best physical-gates dx m: `0.08117556345991897`
- best physical-gates failure: `delta_x_m_min, hold_s`

## HiWonder Near-gait Visual Evidence

Artifact ok: `True`
Failed artifact checks: `none`
Motion evidence: `False`
Active motion evidence: `True`
Walking success: `False`
Controller: `env_hiwonder_sine_prior`
Locomotion action prior: `hiwonder_sine`
Locomotion prior feedback: `{'pitch': 2.0, 'roll': -1.5, 'yaw': 0.25}`
Termination: `time_limit`
Final tracked dx m: `0.1411921941694567`
Final tracked dy m: `-0.05698718166626609`
Final yaw rad: `-0.3642742798674044`
Max success window s: `0.0`
Max abs pitch rad: `0.5213942518786491`
Max abs roll rad: `0.1762227275055259`
Max abs yaw rad: `0.3940176062810571`
Foot contact switches: `9`
Video: `evidence/hiwonder_near_gait_visual_sine_feedback_scale028/env_hiwonder_sine_prior.mp4`
Contact sheet: `evidence/hiwonder_near_gait_visual_sine_feedback_scale028/env_hiwonder_sine_prior_contact.jpg`

## HiWonder Stabilized Gait Search

Search ok: `False`
Candidates: `18`
Best success-window controller: `sine_freeze_s216_b0`
Best success window s: `0.0`
Best success-window dx m: `0.2827617409167032`
Best success-window failure: `delta_x_m_min, max_abs_delta_yaw_rad, no_fall, hold_s`
Report: `/home/shaw/milady/eliza/packages/robot/evidence/hiwonder_stabilized_gait_search.json`

## Multi-profile Walk Feasibility

Cross-profile walk ok: `False`
Valid walking profiles: `0`
Passive-success profiles: `0`

| profile | active success | passive success | selected dx m | passive dx m | most-forward controller | most-forward dx m | most-forward failure |
|---|---|---|---:|---:|---|---:|---|
| `hiwonder-ainex` | `False` | `False` | 0.144 | 0.001 | `bezier_profile` | 0.162 | `torso_z_min_ratio, delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `unitree-g1` | `False` | `False` | -0.534 | -0.000 | `deterministic_smoke` | -0.534 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, min_swing_foot_clearance_m, hold_s` |
| `unitree-h1` | `False` | `False` | -0.252 | -0.315 | `deterministic_smoke` | -0.252 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, min_swing_foot_clearance_m, hold_s` |
| `unitree-r1` | `False` | `False` | 0.412 | 0.444 | `unitree_r1_stance_gait_seeded_1` | 0.825 | `no_fall, min_swing_foot_clearance_m, max_foot_slip_m_s, hold_s` |
| `asimov-1` | `False` | `False` | -0.300 | -0.376 | `deterministic_smoke` | -0.300 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, max_self_collision_count, hold_s` |

## Obstacle Course

Existing evidence failed checks: `demo_json, trajectory_matrix_shapes, obstacle_beats_passive_baseline, obstacle_trace_rollouts`
Fresh smoke artifact ok: `True`
Fresh smoke benchmark model: `2d_point_robot`
Fresh smoke proves Alberta obstacle learning: `True`
Fresh smoke proves MuJoCo/real robot walking: `False`
Fresh smoke note: `Fresh obstacle smoke is a task-conditioned 2D point-robot benchmark; it validates Alberta obstacle-course learning and path traces, not MuJoCo or real robot walking.`
Fresh smoke artifact failed checks: `none`
Fresh smoke beats passive baseline: `True`
Fresh smoke passive baseline is a control: `True`
Fresh smoke trace rollouts ok: `True`
Fresh smoke trace consistency: `True`
Fresh smoke has successful final clear trace: `True`
Fresh smoke Alberta final clear rate: `0.6666666666666666`
Fresh smoke Alberta majority final clear: `True`
Fresh smoke Alberta step trace reaches obstacle x: `True`
Fresh smoke Alberta step trace clears obstacle centerline: `True`
Fresh smoke Alberta step trace passes obstacle: `True`
Fresh smoke Alberta step trace has no collision: `True`
Fresh smoke Alberta step clearance matches summary: `True`
Fresh smoke Alberta step clearance stays positive: `True`
Fresh smoke Alberta samples obstacle band: `True`
Fresh smoke Alberta detours outside obstacle radius in band: `True`
Fresh smoke demo frames: `6`
Fresh smoke demo video bytes json/file: `151820` / `151820`
Fresh smoke demo video: `/home/shaw/milady/eliza/packages/robot/evidence/obstacle_motion_trajectory_audit_smoke/obstacle_course_demo.mp4`

Fresh smoke motion summary:

```json
{
  "alberta": {
    "seeds": 1,
    "final_success_rate_mean": 0.8888888888888888,
    "final_collision_rate_mean": 0.1111111111111111,
    "final_passed_obstacle_rate_mean": 0.8888888888888888,
    "final_forward_progress_m_mean": 2.123314102490743,
    "final_min_obstacle_clearance_m_min": -0.0015737402439117698
  },
  "ppo": {
    "seeds": 1,
    "final_success_rate_mean": 0.0,
    "final_collision_rate_mean": 0.0,
    "final_passed_obstacle_rate_mean": 0.0,
    "final_forward_progress_m_mean": 0.7016034192509122,
    "final_min_obstacle_clearance_m_min": 0.05481857180595395
  }
}
```

Fresh smoke trajectory samples:

| learner | steps | start x | final x | max x | progress m | reached obstacle x | cleared obstacle centerline | passed obstacle | collision | min clearance summary/steps m | clearance match | band samples | max abs y in band m |
|---|---:|---:|---:|---:|---:|---|---|---|---|---:|---|---:|---:|
| `alberta` | 60 | -1.187 | 1.099 | 1.099 | 2.287 | `True` | `True` | `True` | `False` | 0.039 / 0.039 | `True` | 13 | 0.404 |
| `ppo` | 81 | -1.192 | -0.299 | -0.299 | 0.893 | `False` | `False` | `False` | `False` | 0.058 / 0.058 | `True` | 0 | 0.000 |

## Conclusion

The current historical Nebius artifacts do not prove learned robot walking/turning or a physically meaningful obstacle-course result. The patched benchmark now records forward progress, obstacle passing, collision rate, success rate, and top-down rollout traces; fresh smoke evidence shows the harness can expose those facts. A production claim should require these physical checks.
