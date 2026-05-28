# Robot Motion And Learning Audit

Overall ok: `False`

## Findings

- Existing production robot videos prove physical walking/turning: `False`.
- Existing learned-policy curriculum eval proves task success and physical motion: `False`.
- Local short learning probe shows actual learning signal: `True`.
- Local short learning probe reaches walking success: `False`.
- Open-loop task feasibility candidates can satisfy walking: `False`.
- Open-loop gait search finds a walking primitive: `False`.
- Cross-profile walking evidence beats passive baselines: `False`.
- Existing Nebius obstacle-course evidence has physical rollout metrics: `False`.
- Fresh obstacle smoke benchmark with physical metrics and path traces passes: `True`.

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
| `stand_up` | `success_rate_full, torso_height_gain, tracked_height_finite_positive, tracked_height_gain` | 0.00 |
| `walk_forward` | `success_rate_full, tracked_height_present, tracked_delta_x_forward, tracked_lateral_drift_bound` | 0.00 |
| `walk_backward` | `success_rate_full, tracked_height_present, tracked_delta_x_backward, tracked_lateral_drift_bound` | 0.00 |
| `sidestep_left` | `success_rate_full, tracked_height_present, tracked_delta_y_left, tracked_forward_drift_bound` | 0.00 |
| `sidestep_right` | `success_rate_full, tracked_height_present, tracked_delta_y_right, tracked_forward_drift_bound` | 0.00 |
| `turn_left` | `success_rate_full, tracked_height_present, delta_yaw_left, tracked_translation_drift_bound` | 0.00 |
| `turn_right` | `success_rate_full, tracked_height_present, delta_yaw_right, tracked_translation_drift_bound` | 0.00 |

## Local Learning Probe

Probe ok as walking evidence: `False`
Verdict: `not_walking_after_8k_single_task`
Reward delta trained-zero: `626.0397703636572`
Forward delta trained-zero m: `0.13852206620789437`

## Open-loop Task Feasibility

Feasibility ok: `False`
Profile: `hiwonder-ainex`

| task | best controller | best dx m | most-forward controller | most-forward dx m | passive dx m | termination | unmet predicates |
|---|---|---:|---|---:|---:|---|---|
| `stand_up` | `deterministic_smoke` | -0.186 | `deterministic_smoke` | -0.186 | -0.185 | `fall` | `torso_z_max_ratio, hold_s` |
| `sit_down` | `deterministic_smoke` | 0.212 | `deterministic_smoke` | 0.212 | -0.024 | `fall` | `torso_z_max_m, max_abs_delta_x_m, max_abs_delta_yaw_rad, no_fall, hold_s` |
| `walk_forward` | `deterministic_smoke` | -0.238 | `motion_clip` | 0.142 | -0.026 | `fall` | `delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `walk_backward` | `bezier_trimmed` | -0.227 | `bezier_profile` | 0.043 | -0.026 | `fall` | `delta_x_m_max, max_lateral_drift_m, no_fall, min_alternating_foot_contacts, hold_s` |
| `sidestep_left` | `deterministic_smoke` | -0.057 | `bezier_profile` | 0.066 | -0.026 | `fall` | `no_fall, min_alternating_foot_contacts, hold_s` |
| `sidestep_right` | `deterministic_wide` | 0.003 | `bezier_profile` | 0.041 | -0.026 | `fall` | `delta_y_m_max, no_fall, min_alternating_foot_contacts, hold_s` |
| `turn_left` | `deterministic_wide` | -0.003 | `motion_clip` | 0.149 | -0.026 | `fall` | `delta_yaw_rad_min, no_fall, hold_s` |
| `turn_right` | `deterministic_wide` | -0.192 | `bezier_profile` | 0.044 | -0.026 | `fall` | `delta_yaw_rad_max, no_fall, hold_s` |

## Open-loop Gait Search

Search ok: `False`
Candidates: `15`

| criterion | controller | final dx m | peak dx m | termination | reason |
|---|---|---:|---:|---|---|
| best score | `sinusoidal_seeded_1` | -0.004 | 0.105 | `time_limit` | `none` |
| best forward | `sinusoidal_seeded_5` | 0.366 | 0.366 | `fall` | `fall: |pitch|=0.65 > 0.6` |
| best peak forward | `sinusoidal_seeded_5` | 0.366 | 0.366 | `fall` | `fall: |pitch|=0.65 > 0.6` |
| best stable peak forward | `sinusoidal_seeded_3` | 0.117 | 0.135 | `time_limit` | `none` |

## Multi-profile Walk Feasibility

Cross-profile walk ok: `False`
Valid walking profiles: `0`
Passive-success profiles: `0`

| profile | active success | passive success | selected dx m | passive dx m | most-forward controller | most-forward dx m |
|---|---|---|---:|---:|---|---:|
| `hiwonder-ainex` | `False` | `False` | 0.005 | -0.014 | `motion_clip` | 0.063 |
| `unitree-g1` | `False` | `False` | -0.410 | -0.000 | `deterministic_smoke` | -0.410 |
| `unitree-h1` | `False` | `False` | -0.230 | -0.317 | `deterministic_smoke` | -0.230 |
| `unitree-r1` | `False` | `False` | 0.227 | 0.423 | `deterministic_smoke` | 0.227 |
| `asimov-1` | `False` | `False` | -0.287 | -0.378 | `deterministic_smoke` | -0.287 |

## Obstacle Course

Existing evidence failed checks: `demo_json, trajectory_matrix_shapes, obstacle_beats_passive_baseline`
Fresh smoke beats passive baseline: `True`
Fresh smoke passive baseline is a control: `True`

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

## Conclusion

The current historical Nebius artifacts do not prove learned robot walking/turning or a physically meaningful obstacle-course result. The patched benchmark now records forward progress, obstacle passing, collision rate, success rate, and top-down rollout traces; fresh smoke evidence shows the harness can expose those facts. A production claim should require these physical checks.
