# HiWonder Random Sine Gait Search

Any success: `False`
Candidates: `80`
Seed: `20260604`

## Failure Frontier

- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best forward controller: `random_sine_007`
- best forward peak dx m: `0.1834969404697103`
- best no-fall straight controller: `random_sine_019`
- best no-fall straight peak dx m: `0.02835716255287721`

## Local Refinement

- base controller: `random_sine_036`
- candidates: `80`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`

## Transition Refinement

- base controller: `local_random_sine_036_067`
- candidates: `144`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `transition_local_random_sine_036_067_000`
- best success window s: `0.0`
- best success-window dx m: `0.18231615919864338`
- best success-window failure: `delta_x_m_min, no_fall, min_swing_foot_clearance_m, hold_s`

## Feedback Refinement

- base controller: `local_random_sine_036_067`
- candidates: `501`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `feedback_local_random_sine_036_067_095`
- best success window s: `0.0`
- best success-window dx m: `0.25021631551563184`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, no_fall, min_swing_foot_clearance_m, max_foot_slip_m_s, hold_s`

## Hybrid Recovery Refinement

- base controller: `feedback_local_random_sine_036_067_095`
- candidates: `1004`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `hybrid_feedback_local_random_sine_036_067_095_479`
- best success window s: `0.0`
- best success-window dx m: `0.25543608937418905`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, no_fall, min_swing_foot_clearance_m, max_foot_slip_m_s, hold_s`
- best physical-gates controller: `hybrid_feedback_local_random_sine_036_067_095_101`
- best physical-gates dx m: `0.21606898498050128`
- best physical-gates torso z m: `0.19108793529112353`
- best physical-gates max foot slip m/s: `0.3188526928424835`
- best physical-gates failure: `delta_x_m_min, no_fall, min_swing_foot_clearance_m, hold_s`

## Stable Bridge Refinement

- base controller: `hybrid_feedback_local_random_sine_036_067_095_101`
- candidates: `168`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best stable-bridge controller: `stable_bridge_hybrid_feedback_local_random_sine_036_067_095_101_014`
- best stable-bridge dx m: `0.21606898498050128`
- best stable-bridge torso z m: `0.19108793529112353`
- best stable-bridge max foot slip m/s: `0.3188526928424835`
- best stable-bridge failure: `delta_x_m_min, no_fall, min_swing_foot_clearance_m, hold_s`
- best physical-gates controller: `stable_bridge_hybrid_feedback_local_random_sine_036_067_095_101_019`
- best physical-gates dx m: `0.19660954844350947`
- best physical-gates failure: `delta_x_m_min, no_fall, hold_s`
