# HiWonder Random Sine Gait Search

Any success: `False`
Candidates: `24`
Seed: `20260601`

## Failure Frontier

- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best forward controller: `random_sine_018`
- best forward peak dx m: `0.1850789880801503`
- best no-fall straight controller: `None`
- best no-fall straight peak dx m: `None`

## Local Refinement

- base controller: `random_sine_023`
- candidates: `24`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`

## Transition Refinement

- base controller: `local_random_sine_023_013`
- candidates: `144`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `transition_local_random_sine_023_013_000`
- best success window s: `0.0`
- best success-window dx m: `0.17262192686750688`
- best success-window failure: `delta_x_m_min, no_fall, hold_s`

## Feedback Refinement

- base controller: `local_random_sine_023_013`
- candidates: `501`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `feedback_local_random_sine_023_013_095`
- best success window s: `0.0`
- best success-window dx m: `0.2649773635930304`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, max_abs_delta_yaw_rad, no_fall, max_foot_slip_m_s, hold_s`

## Hybrid Recovery Refinement

- base controller: `feedback_local_random_sine_023_013_054`
- candidates: `1004`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `hybrid_feedback_local_random_sine_023_013_054_028`
- best success window s: `0.0`
- best success-window dx m: `0.2164337350616089`
- best success-window failure: `delta_x_m_min, max_abs_delta_yaw_rad, no_fall, max_foot_slip_m_s, hold_s`
- best physical-gates controller: `hybrid_feedback_local_random_sine_023_013_054_1003`
- best physical-gates dx m: `0.0585624811605833`
- best physical-gates torso z m: `0.23794112970117426`
- best physical-gates max foot slip m/s: `0.2888130247592926`
- best physical-gates failure: `delta_x_m_min, hold_s`

## Stable Bridge Refinement

- base controller: `hybrid_feedback_local_random_sine_023_013_054_1003`
- candidates: `168`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best stable-bridge controller: `stable_bridge_hybrid_feedback_local_random_sine_023_013_054_1003_090`
- best stable-bridge dx m: `0.19251734061013814`
- best stable-bridge torso z m: `0.19258218288290016`
- best stable-bridge max foot slip m/s: `0.2681017816066742`
- best stable-bridge failure: `delta_x_m_min, no_fall, hold_s`
- best physical-gates controller: `stable_bridge_hybrid_feedback_local_random_sine_023_013_054_1003_014`
- best physical-gates dx m: `0.0585624811605833`
- best physical-gates failure: `delta_x_m_min, hold_s`
