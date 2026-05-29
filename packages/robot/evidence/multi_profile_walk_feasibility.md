# Multi-profile Walk Feasibility

Overall ok: `False`
Valid walking profiles: `0`
Passive-success profiles: `0`

| profile | active success | passive success | selected dx m | passive dx m | most-forward controller | most-forward dx m | most-forward failure |
|---|---|---|---:|---:|---|---:|---|
| `hiwonder-ainex` | `False` | `False` | 0.144 | 0.001 | `bezier_profile` | 0.162 | `torso_z_min_ratio, delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s` |
| `unitree-g1` | `False` | `False` | -0.534 | -0.000 | `deterministic_smoke` | -0.534 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, min_swing_foot_clearance_m, hold_s` |
| `unitree-h1` | `False` | `False` | -0.252 | -0.315 | `deterministic_smoke` | -0.252 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, min_swing_foot_clearance_m, hold_s` |
| `unitree-r1` | `False` | `False` | 0.412 | 0.444 | `unitree_r1_stance_gait_seeded_1` | 0.825 | `no_fall, min_swing_foot_clearance_m, max_foot_slip_m_s, hold_s` |
| `asimov-1` | `False` | `False` | -0.300 | -0.376 | `deterministic_smoke` | -0.300 | `delta_x_m_min, no_fall, min_alternating_foot_contacts, max_self_collision_count, hold_s` |
