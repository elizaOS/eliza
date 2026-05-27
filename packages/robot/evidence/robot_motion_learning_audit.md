# Robot Motion And Learning Audit

Overall ok: `False`

## Findings

- Existing production robot videos prove physical walking/turning: `False`.
- Existing Nebius obstacle-course evidence has physical rollout metrics: `False`.
- Fresh obstacle smoke benchmark with new physical metrics passes: `True`.

## Failed Production Video Motion Checks

| profile | action | failed checks |
|---|---|---|
| `asimov-1` | `combined_actions` | `telemetry_action_progress` |
| `asimov-1` | `turn_left` | `telemetry_action_progress` |
| `asimov-1` | `turn_right` | `telemetry_action_progress` |
| `asimov-1` | `walk_forward` | `telemetry_action_progress` |
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

## Obstacle Course

Existing evidence failed checks: `motion_matrix_shapes, obstacle_motion_summary, obstacle_forward_progress, obstacle_passes_obstacle, obstacle_collision_rate`

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
    "final_forward_progress_m_mean": 0.7107810775438944,
    "final_min_obstacle_clearance_m_min": 0.038279713392257664
  }
}
```

## Conclusion

The current historical Nebius artifacts do not prove real robot walking or a physically meaningful obstacle-course result. The patched benchmark now records forward progress, obstacle passing, collision rate, and success rate; fresh smoke evidence shows the harness can expose those facts. A production claim should require these physical checks.
