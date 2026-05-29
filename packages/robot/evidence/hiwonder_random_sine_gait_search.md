# HiWonder Random Sine Gait Search

Any success: `False`
Candidates: `240`
Seed: `202605283`

## Failure Frontier

- primary gap: `straightness`
- forward-displacement candidates: `4`
- forward + no-fall + straight candidates: `0`
- best forward controller: `random_sine_009`
- best forward peak dx m: `0.31289690486361366`
- best no-fall straight controller: `random_sine_156`
- best no-fall straight peak dx m: `0.07306374952125357`

## Local Refinement

- base controller: `random_sine_013`
- candidates: `220`
- successes: `0`
- primary gap: `stability`
- forward-displacement candidates: `10`
- forward + no-fall + straight candidates: `0`

## Transition Refinement

- base controller: `local_random_sine_013_045`
- candidates: `144`
- successes: `0`
- primary gap: `stability`
- forward-displacement candidates: `144`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `transition_local_random_sine_013_045_000`
- best success window s: `0.0`
- best success-window dx m: `0.30805073523872256`
- best success-window failure: `no_fall, min_alternating_foot_contacts, hold_s`

## Feedback Refinement

- base controller: `local_random_sine_013_045`
- candidates: `501`
- successes: `0`
- primary gap: `stability`
- forward-displacement candidates: `189`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `feedback_local_random_sine_013_045_093`
- best success window s: `0.0`
- best success-window dx m: `0.3630430773073147`
- best success-window failure: `no_fall, hold_s`

## Hybrid Recovery Refinement

- base controller: `feedback_local_random_sine_013_045_093`
- candidates: `80`
- successes: `0`
- primary gap: `stability`
- forward-displacement candidates: `28`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `hybrid_feedback_local_random_sine_013_045_093_048`
- best success window s: `0.0`
- best success-window dx m: `0.30805073523872256`
- best success-window failure: `no_fall, min_alternating_foot_contacts, hold_s`
