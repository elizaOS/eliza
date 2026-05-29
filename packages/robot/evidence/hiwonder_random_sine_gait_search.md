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
- best success-window failure: `delta_x_m_min, no_fall, min_alternating_foot_contacts, hold_s`

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
- best success-window failure: `delta_x_m_min, no_fall, hold_s`

## Hybrid Recovery Refinement

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
