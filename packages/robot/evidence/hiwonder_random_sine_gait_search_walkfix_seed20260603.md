# HiWonder Random Sine Gait Search

Any success: `False`
Candidates: `300`
Seed: `20260603`

## Failure Frontier

- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best forward controller: `random_sine_224`
- best forward peak dx m: `0.19745079264431326`
- best no-fall straight controller: `random_sine_165`
- best no-fall straight peak dx m: `0.0570072590028773`

## Local Refinement

- base controller: `random_sine_279`
- candidates: `80`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`

## Transition Refinement

- base controller: `local_random_sine_279_070`
- candidates: `144`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `transition_local_random_sine_279_070_000`
- best success window s: `0.0`
- best success-window dx m: `0.2014814919571972`
- best success-window failure: `delta_x_m_min, no_fall, hold_s`

## Feedback Refinement

- base controller: `local_random_sine_279_070`
- candidates: `501`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `feedback_local_random_sine_279_070_082`
- best success window s: `0.0`
- best success-window dx m: `0.2858152987143861`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, no_fall, max_foot_slip_m_s, hold_s`

## Hybrid Recovery Refinement

- base controller: `feedback_local_random_sine_279_070_082`
- candidates: `1004`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best success-window controller: `hybrid_feedback_local_random_sine_279_070_082_073`
- best success window s: `0.0`
- best success-window dx m: `0.2977672481376806`
- best success-window failure: `torso_z_min_ratio, delta_x_m_min, no_fall, max_foot_slip_m_s, hold_s`
- best physical-gates controller: `hybrid_feedback_local_random_sine_279_070_082_1003`
- best physical-gates dx m: `0.05905141311386936`
- best physical-gates torso z m: `0.23795750236272975`
- best physical-gates max foot slip m/s: `0.2888130247592926`
- best physical-gates failure: `delta_x_m_min, hold_s`

## Stable Bridge Refinement

- base controller: `hybrid_feedback_local_random_sine_279_070_082_1003`
- candidates: `168`
- successes: `0`
- primary gap: `forward_displacement`
- forward-displacement candidates: `0`
- forward + no-fall + straight candidates: `0`
- best stable-bridge controller: `stable_bridge_hybrid_feedback_local_random_sine_279_070_082_1003_090`
- best stable-bridge dx m: `0.19251734061013814`
- best stable-bridge torso z m: `0.19258218288290016`
- best stable-bridge max foot slip m/s: `0.2681017816066742`
- best stable-bridge failure: `delta_x_m_min, no_fall, hold_s`
- best physical-gates controller: `stable_bridge_hybrid_feedback_local_random_sine_279_070_082_1003_003`
- best physical-gates dx m: `0.05932939870423343`
- best physical-gates failure: `delta_x_m_min, hold_s`
