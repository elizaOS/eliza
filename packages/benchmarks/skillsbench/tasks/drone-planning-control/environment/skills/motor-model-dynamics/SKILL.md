---
name: motor-model-dynamics
description: Use this skill when simulating quadrotor physical dynamics — mapping desired thrust/moments to individual motor RPMs via a propeller allocation matrix, applying first-order motor lag, and integrating the nonlinear equations of motion (translational and rotational) using RK45.
---

# Motor Model and Dynamics Simulation

## Overview

Two modules form the physics layer of the simulator:

1. **Motor model** — maps desired `[F, Mx, My, Mz]` → desired motor RPMs → applies first-order lag → returns actual thrust and moments
2. **Dynamics** — nonlinear equations of motion; given forces and moments, returns the 16-element state derivative for ODE integration

## Motor Model

### Propeller Allocation Matrix (X-frame quadrotor)

The 4×4 allocation matrix maps `[F, Mx, My, Mz]` to squared motor RPMs. For an X-frame with arm length `d`, thrust coefficient `cT`, and torque coefficient `cQ`:

```
         motor:  1      2      3      4
Thrust:         +cT    +cT    +cT    +cT
Roll  (Mx):      0    +d·cT    0    -d·cT
Pitch (My):    -d·cT    0    +d·cT    0
Yaw   (Mz):    -cQ    +cQ    -cQ    +cQ
```

### Implementation Logic

1. Build the 4×4 `prop_matrix` from `cT`, `cQ`, and `d`.
2. Solve `prop_matrix @ rpm_sq = [F, Mx, My, Mz]` for `rpm_sq` (desired squared RPMs).
3. Take `sqrt` of each element (clamp negatives to 0 first), then clip to `[rpm_min, rpm_max]`.
4. Apply first-order motor lag: `rpm_dot = km * (rpm_desired - rpm_current)`.
5. Compute actual force/moment using `prop_matrix @ (motor_rpm ** 2)` and return `(F_actual, M_actual, rpm_dot)`.

## Dynamics (Equations of Motion)

### State vector (16,)

| Indices | Meaning |
|---|---|
| 0:3 | Position [x, y, z] |
| 3:6 | Velocity [vẋ, vẏ, vż] |
| 6:9 | Euler angles [φ, θ, ψ] |
| 9:12 | Angular velocity [p, q, r] |
| 12:16 | Motor RPM [ω₁, ω₂, ω₃, ω₄] |

### Implementation Logic

Compute `state_dot` (16,) from current state and applied forces/moments:

1. **Position derivative** = current velocity (`state[3:6]`).
2. **Velocity derivative** = gravity + thrust projected into world frame via ZYX Euler rotation. The x/y accelerations depend on `F/m`, `sin`/`cos` of all three Euler angles. The z acceleration is `−g + (F/m)·cos(φ)·cos(θ)`.
3. **Euler angle derivative** = current angular velocity (`state[9:12]`).
4. **Angular velocity derivative** = `I⁻¹ M` (solve inertia matrix against moment vector).
5. **Motor RPM derivative** = `rpm_motor_dot` from the motor model.

## RK45 Integration

Use `scipy.integrate.solve_ivp` with `method='RK45'` over each timestep `[t_k, t_{k+1}]`. The ODE function wraps `dynamics(params, s, F_actual, M_actual, rpm_motor_dot)` with `F_actual` and `M_actual` held constant for the step. After solving, take the last column of `sol.y` as the new state.

## Motor Physical Limits

| Parameter | Value | Meaning |
|---|---|---|
| `rpm_min` | 3000 | Minimum motor speed (motors always spinning) |
| `rpm_max` | 20000 | Maximum motor speed |
| `motor_constant` km | 36.5 s⁻¹ | First-order time constant; τ = 1/km ≈ 27 ms |

## Max Thrust Calculation

Derived from motor limits:
- `T_max = 4 * cT * rpm_max²` (all 4 motors at max RPM)
- `T_min = 4 * cT * rpm_min²`
- Thrust-to-weight ratio: `twr = T_max / (mass * gravity)`
- Max upward acceleration: `(T_max − mass·g) / mass`
- Max downward acceleration: `(mass·g − T_min) / mass`
