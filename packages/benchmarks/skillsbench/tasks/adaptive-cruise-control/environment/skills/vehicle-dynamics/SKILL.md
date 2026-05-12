---
name: vehicle-dynamics
description: Use this skill when simulating vehicle motion, calculating safe following distances, time-to-collision, speed/position updates, or implementing vehicle state machines for cruise control modes.
---

# Vehicle Dynamics Simulation

## Basic Kinematic Model

For vehicle simulations, use discrete-time kinematic equations.

**Speed Update:**
```python
new_speed = current_speed + acceleration * dt
new_speed = max(0, new_speed)  # Speed cannot be negative
```

**Position Update:**
```python
new_position = current_position + speed * dt
```

**Distance Between Vehicles:**
```python
# When following another vehicle
relative_speed = ego_speed - lead_speed
new_distance = current_distance - relative_speed * dt
```

## Safe Following Distance

The time headway model calculates safe following distance:

```python
def safe_following_distance(speed, time_headway, min_distance):
    """
    Calculate safe distance based on current speed.

    Args:
        speed: Current vehicle speed (m/s)
        time_headway: Time gap to maintain (seconds)
        min_distance: Minimum distance at standstill (meters)
    """
    return speed * time_headway + min_distance
```

## Time-to-Collision (TTC)

TTC estimates time until collision at current velocities:

```python
def time_to_collision(distance, ego_speed, lead_speed):
    """
    Calculate time to collision.

    Returns None if not approaching (ego slower than lead).
    """
    relative_speed = ego_speed - lead_speed

    if relative_speed <= 0:
        return None  # Not approaching

    return distance / relative_speed
```

## Acceleration Limits

Real vehicles have physical constraints:

```python
def clamp_acceleration(accel, max_accel, max_decel):
    """Constrain acceleration to physical limits."""
    return max(max_decel, min(accel, max_accel))
```

## State Machine Pattern

Vehicle control often uses mode-based logic:

```python
def determine_mode(lead_present, ttc, ttc_threshold):
    """
    Determine operating mode based on conditions.

    Returns one of: 'cruise', 'follow', 'emergency'
    """
    if not lead_present:
        return 'cruise'

    if ttc is not None and ttc < ttc_threshold:
        return 'emergency'

    return 'follow'
```
