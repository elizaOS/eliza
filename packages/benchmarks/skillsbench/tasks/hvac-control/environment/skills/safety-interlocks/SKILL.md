---
name: safety-interlocks
description: Implement safety interlocks and protective mechanisms to prevent equipment damage and ensure safe control system operation.
---

# Safety Interlocks for Control Systems

## Overview

Safety interlocks are protective mechanisms that prevent equipment damage and ensure safe operation. In control systems, the primary risks are output saturation and exceeding safe operating limits.

## Implementation Pattern

Always check safety conditions BEFORE applying control outputs:

```python
def apply_safety_limits(measurement, command, max_limit, min_limit, max_output, min_output):
    """
    Apply safety checks and return safe command.

    Args:
        measurement: Current sensor reading
        command: Requested control output
        max_limit: Maximum safe measurement value
        min_limit: Minimum safe measurement value
        max_output: Maximum output command
        min_output: Minimum output command

    Returns:
        tuple: (safe_command, safety_triggered)
    """
    safety_triggered = False

    # Check for over-limit - HIGHEST PRIORITY
    if measurement >= max_limit:
        command = min_output  # Emergency cutoff
        safety_triggered = True

    # Clamp output to valid range
    command = max(min_output, min(max_output, command))

    return command, safety_triggered
```

## Integration with Control Loop

```python
class SafeController:
    def __init__(self, controller, max_limit, min_output=0.0, max_output=100.0):
        self.controller = controller
        self.max_limit = max_limit
        self.min_output = min_output
        self.max_output = max_output
        self.safety_events = []

    def compute(self, measurement, dt):
        """Compute safe control output."""
        # Check safety FIRST
        if measurement >= self.max_limit:
            self.safety_events.append({
                "measurement": measurement,
                "action": "emergency_cutoff"
            })
            return self.min_output

        # Normal control
        output = self.controller.compute(measurement, dt)

        # Clamp to valid range
        return max(self.min_output, min(self.max_output, output))
```

## Safety During Open-Loop Testing

During calibration/excitation, safety is especially important because there's no feedback control:

```python
def run_test_with_safety(system, input_value, duration, dt, max_limit):
    """Run open-loop test while monitoring safety limits."""
    data = []
    current_input = input_value

    for step in range(int(duration / dt)):
        result = system.step(current_input)
        data.append(result)

        # Safety check
        if result["output"] >= max_limit:
            current_input = 0.0  # Cut input

    return data
```

## Logging Safety Events

Always log safety events for analysis:

```python
safety_log = {
    "limit": max_limit,
    "events": []
}

if measurement >= max_limit:
    safety_log["events"].append({
        "time": current_time,
        "measurement": measurement,
        "command_before": command,
        "command_after": 0.0,
        "event_type": "limit_exceeded"
    })
```

## Pre-Control Checklist

Before starting any control operation:

1. **Verify sensor reading is reasonable**
   - Not NaN or infinite
   - Within physical bounds

2. **Check initial conditions**
   - Measurement should be at expected starting point
   - Output should start at safe value

3. **Confirm safety limits are configured**
   - Maximum limit threshold set
   - Output clamping enabled

```python
def pre_control_checks(measurement, config):
    """Run pre-control safety verification."""
    assert not np.isnan(measurement), "Measurement is NaN"
    assert config.get("max_limit") is not None, "Safety limit not configured"
    return True
```

## Best Practices

1. **Defense in depth**: Multiple layers of protection
2. **Fail safe**: When in doubt, reduce output
3. **Log everything**: Record all safety events
4. **Never bypass**: Safety code should not be conditionally disabled
5. **Test safety**: Verify interlocks work before normal operation
