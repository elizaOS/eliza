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

## Open-loop Task Feasibility

Feasibility ok: `False`
Profile: `hiwonder-ainex`

| task | best controller | best dx m | best-progress controller | progress | dx m | dy m | hold s | termination | unmet predicates |
|---|---|---:|---|---:|---:|---:|---:|---|---|
| `walk_forward` | `deterministic_smoke` | 0.144 | `bezier_profile` | 0.54 | 0.162 | -0.001 | 0.00 | `fall` | `torso_z_min_ratio, delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `walk_backward` | `deterministic_smoke` | 0.001 | `motion_clip` | 0.23 | -0.046 | 0.000 | 0.00 | `fall` | `delta_x_m_max, no_fall, min_alternating_foot_contacts, min_swing_foot_clearance_m, hold_s` |
| `sidestep_left` | `deterministic_smoke` | 0.002 | `deterministic_wide` | 0.84 | 0.002 | 0.168 | 0.00 | `fall` | `delta_y_m_min, no_fall, min_alternating_foot_contacts, max_self_collision_count, hold_s` |
| `sidestep_right` | `deterministic_smoke` | 0.003 | `deterministic_wide` | 0.84 | 0.002 | -0.168 | 0.00 | `fall` | `delta_y_m_max, no_fall, min_alternating_foot_contacts, max_self_collision_count, hold_s` |

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
- best success-window failure: `delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s`
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
- best success-window failure: `delta_x_m_min, no_fall, hold_s`
Hybrid recovery refinement:
- base controller: `feedback_local_random_sine_013_045_093`
- candidates: `160`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `hybrid_feedback_local_random_sine_013_045_093_004`
- best success window s: `0.0`
- best success-window dx m: `0.2878859722586517`
- best success-window failure: `delta_x_m_min, no_fall, hold_s`

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
| `unitree-g1` | `False` | `False` | -0.534 | -0.000 | `deterministic_smoke` | -0.534 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `unitree-h1` | `False` | `False` | -0.252 | -0.315 | `deterministic_smoke` | -0.252 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `unitree-r1` | `False` | `False` | 0.324 | 0.444 | `deterministic_smoke` | 0.324 | `no_fall, hold_s` |
| `asimov-1` | `False` | `False` | -0.300 | -0.376 | `deterministic_smoke` | -0.300 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |

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

| learner | steps | start x | final x | max x | progress m | reached obstacle x | cleared obstacle centerline | passed obstacle | collision | min clearance m |
|---|---:|---:|---:|---:|---:|---|---|---|---|---:|
| `alberta` | 60 | -1.187 | 1.099 | 1.099 | 2.287 | `True` | `True` | `True` | `False` | 0.039 |
| `ppo` | 81 | -1.192 | -0.299 | -0.299 | 0.893 | `False` | `False` | `False` | `False` | 0.058 |

## Conclusion

The current historical Nebius artifacts do not prove learned robot walking/turning or a physically meaningful obstacle-course result. The patched benchmark now records forward progress, obstacle passing, collision rate, success rate, and top-down rollout traces; fresh smoke evidence shows the harness can expose those facts. A production claim should require these physical checks.
