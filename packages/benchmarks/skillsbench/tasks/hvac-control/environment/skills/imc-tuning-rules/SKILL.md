---
name: imc-tuning-rules
description: Calculate PI/PID controller gains using Internal Model Control (IMC) tuning rules for first-order systems.
---

# IMC Tuning Rules for PI/PID Controllers

## Overview

Internal Model Control (IMC) is a systematic method for tuning PI/PID controllers based on a process model. Once you've identified system parameters (K and tau), IMC provides controller gains.

## Why IMC?

- **Model-based**: Uses identified process parameters directly
- **Single tuning parameter**: Just choose the closed-loop speed (lambda)
- **Guaranteed stability**: For first-order systems, always stable if model is accurate
- **Predictable response**: Closed-loop time constant equals lambda

## IMC Tuning for First-Order Systems

For a first-order process with gain K and time constant tau:

```
Process: G(s) = K / (tau*s + 1)
```

The IMC-tuned PI controller gains are:

```
Kp = tau / (K * lambda)
Ki = Kp / tau = 1 / (K * lambda)
Kd = 0  (derivative not needed for first-order systems)
```

Where:
- `Kp` = Proportional gain
- `Ki` = Integral gain (units: 1/time)
- `Kd` = Derivative gain (zero for first-order)
- `lambda` = Desired closed-loop time constant (tuning parameter)

## Choosing Lambda (λ)

Lambda controls the trade-off between speed and robustness:

| Lambda | Behavior |
|--------|----------|
| `lambda = 0.1 * tau` | Very aggressive, fast but sensitive to model error |
| `lambda = 0.5 * tau` | Aggressive, good for accurate models |
| `lambda = 1.0 * tau` | Moderate, balanced speed and robustness |
| `lambda = 2.0 * tau` | Conservative, robust to model uncertainty |

**Default recommendation**: Start with `lambda = tau`

For noisy systems or uncertain models, use larger lambda.
For precise models and fast response needs, use smaller lambda.

## Implementation

```python
def calculate_imc_gains(K, tau, lambda_factor=1.0):
    """
    Calculate IMC-tuned PI gains for a first-order system.

    Args:
        K: Process gain
        tau: Time constant
        lambda_factor: Multiplier for lambda (default 1.0 = lambda equals tau)

    Returns:
        dict with Kp, Ki, Kd, lambda
    """
    lambda_cl = lambda_factor * tau

    Kp = tau / (K * lambda_cl)
    Ki = Kp / tau
    Kd = 0.0

    return {
        "Kp": Kp,
        "Ki": Ki,
        "Kd": Kd,
        "lambda": lambda_cl
    }
```

## PI Controller Implementation

```python
class PIController:
    def __init__(self, Kp, Ki, setpoint):
        self.Kp = Kp
        self.Ki = Ki
        self.setpoint = setpoint
        self.integral = 0.0

    def compute(self, measurement, dt):
        """Compute control output."""
        error = self.setpoint - measurement

        # Integral term
        self.integral += error * dt

        # PI control law
        output = self.Kp * error + self.Ki * self.integral

        # Clamp to valid range
        output = max(output_min, min(output_max, output))

        return output
```

## Expected Closed-Loop Behavior

With IMC tuning, the closed-loop response is approximately:

```
y(t) = y_setpoint * (1 - exp(-t / lambda))
```

Key properties:
- **Rise time**: ~2.2 * lambda to reach 90% of setpoint
- **Settling time**: ~4 * lambda to reach 98% of setpoint
- **Overshoot**: Minimal for first-order systems
- **Steady-state error**: Zero (integral action eliminates offset)

## Tips

1. **Start conservative**: Use `lambda = tau` initially
2. **Decrease lambda carefully**: Smaller lambda = larger Kp = faster but riskier
3. **Watch for oscillation**: If output oscillates, increase lambda
4. **Anti-windup**: Prevent integral wind-up when output saturates
