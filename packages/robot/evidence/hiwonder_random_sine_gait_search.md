# HiWonder Random Sine Gait Search

Any success: `False`
Candidates: `240`
Seed: `202605283`

## Failure Frontier

- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best forward controller: `random_sine_009`
- best forward peak dx m: `0.22188831674120998`
- best no-fall straight controller: `random_sine_156`
- best no-fall straight peak dx m: `0.05187439403958872`

## Local Refinement

- base controller: `random_sine_013`
- candidates: `220`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`

## Transition Refinement

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

## Feedback Refinement

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

## Hybrid Recovery Refinement

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

## Stable Bridge Refinement

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
