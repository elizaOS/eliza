---
name: pid-controller
description: Use this skill when implementing PID control loops for adaptive cruise control, vehicle speed regulation, throttle/brake management, or any feedback control system requiring proportional-integral-derivative control.
---

# PID Controller Implementation

## Overview

A PID (Proportional-Integral-Derivative) controller is a feedback control mechanism used in industrial control systems. It continuously calculates an error value and applies a correction based on proportional, integral, and derivative terms.

## Control Law

```
output = Kp * error + Ki * integral(error) + Kd * derivative(error)
```

Where:
- `error` = setpoint - measured_value
- `Kp` = proportional gain (reacts to current error)
- `Ki` = integral gain (reacts to accumulated error)
- `Kd` = derivative gain (reacts to rate of change)

## Discrete-Time Implementation

```python
class PIDController:
    def __init__(self, kp, ki, kd, output_min=None, output_max=None):
        self.kp = kp
        self.ki = ki
        self.kd = kd
        self.output_min = output_min
        self.output_max = output_max
        self.integral = 0.0
        self.prev_error = 0.0

    def reset(self):
        """Clear controller state."""
        self.integral = 0.0
        self.prev_error = 0.0

    def compute(self, error, dt):
        """Compute control output given error and timestep."""
        # Proportional term
        p_term = self.kp * error

        # Integral term
        self.integral += error * dt
        i_term = self.ki * self.integral

        # Derivative term
        derivative = (error - self.prev_error) / dt if dt > 0 else 0.0
        d_term = self.kd * derivative
        self.prev_error = error

        # Total output
        output = p_term + i_term + d_term

        # Output clamping (optional)
        if self.output_min is not None:
            output = max(output, self.output_min)
        if self.output_max is not None:
            output = min(output, self.output_max)

        return output
```

## Anti-Windup

Integral windup occurs when output saturates but integral keeps accumulating. Solutions:

1. **Clamping**: Limit integral term magnitude
2. **Conditional Integration**: Only integrate when not saturated
3. **Back-calculation**: Reduce integral when output is clamped

## Tuning Guidelines

**Manual Tuning:**
1. Set Ki = Kd = 0
2. Increase Kp until acceptable response speed
3. Add Ki to eliminate steady-state error
4. Add Kd to reduce overshoot

**Effect of Each Gain:**
- Higher Kp -> faster response, more overshoot
- Higher Ki -> eliminates steady-state error, can cause oscillation
- Higher Kd -> reduces overshoot, sensitive to noise
