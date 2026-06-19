"""Session-level safety controls for bridge command handling."""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from eliza_robot.bridge.protocol import CommandEnvelope


@dataclass
class RateLimitResult:
    allowed: bool
    retry_after_sec: float


class CommandRateLimiter:
    """Simple sliding-window rate limiter."""

    def __init__(self, max_commands_per_sec: int) -> None:
        if max_commands_per_sec <= 0:
            raise ValueError("max_commands_per_sec must be positive")
        self._limit = max_commands_per_sec
        self._window_sec = 1.0
        self._timestamps: deque[float] = deque()

    def check(self) -> RateLimitResult:
        now = time.monotonic()
        while self._timestamps and (now - self._timestamps[0]) > self._window_sec:
            self._timestamps.popleft()

        if len(self._timestamps) >= self._limit:
            retry_after_sec = self._window_sec - (now - self._timestamps[0])
            return RateLimitResult(allowed=False, retry_after_sec=max(0.0, retry_after_sec))

        self._timestamps.append(now)
        return RateLimitResult(allowed=True, retry_after_sec=0.0)


def is_deadman_heartbeat_command(command: CommandEnvelope) -> bool:
    """Commands that count as keepalive movement/control activity."""
    return command.command in {
        "walk.set", "walk.command", "head.set", "action.play",
        "servo.set", "policy.tick",
    }


# ---------------------------------------------------------------------------
# Policy motion-bound safety checks
# ---------------------------------------------------------------------------

# Maximum absolute deltas per policy tick (prevents runaway commands)
POLICY_WALK_X_MAX = 0.05
POLICY_WALK_Y_MAX = 0.05
POLICY_WALK_YAW_MAX = 10.0
POLICY_WALK_HEIGHT_MIN = 0.015
POLICY_WALK_HEIGHT_MAX = 0.06
POLICY_WALK_SPEED_MIN = 1
POLICY_WALK_SPEED_MAX = 4
POLICY_HEAD_PAN_MAX = 1.5   # radians
POLICY_HEAD_TILT_MAX = 1.0  # radians


@dataclass
class PolicyGuardResult:
    """Result of a policy motion-bound check."""
    allowed: bool
    reason: str = ""
    clamped: dict[str, Any] = field(default_factory=dict)


def check_policy_motion_bounds(action: dict[str, Any]) -> PolicyGuardResult:
    """Check and clamp a policy action chunk against hard safety limits.

    Returns a PolicyGuardResult with the clamped values. If any value was
    out of bounds, ``allowed`` is still True but ``reason`` describes what
    was clamped. If the action is fundamentally invalid, ``allowed`` is False.
    """
    clamped: dict[str, Any] = {}
    reasons: list[str] = []
    invalid: list[str] = []

    def _num(name: str, default: float) -> float:
        """Parse a float field; flag non-finite/garbage and substitute a safe 0."""
        try:
            v = float(action.get(name, default))
        except (TypeError, ValueError):
            invalid.append(f"{name}=non-numeric")
            return 0.0
        if not math.isfinite(v):
            invalid.append(f"{name}={v}")
            return 0.0
        return v

    # Walk parameters. A diverged policy commonly emits NaN/inf — these MUST be
    # rejected (allowed=False), not silently clamped, since abs(nan) > MAX is
    # False and a raw NaN would otherwise pass straight through to the robot.
    walk_x = _num("walk_x", 0.0)
    walk_y = _num("walk_y", 0.0)
    walk_yaw = _num("walk_yaw", 0.0)
    walk_height = _num("walk_height", 0.036)  # 0.0 if invalid -> clamped to MIN below
    try:
        walk_speed = int(action.get("walk_speed", 2))
    except (TypeError, ValueError, OverflowError):
        invalid.append("walk_speed=non-integer")
        walk_speed = POLICY_WALK_SPEED_MIN

    if abs(walk_x) > POLICY_WALK_X_MAX:
        reasons.append(f"walk_x clamped {walk_x:.4f}->{_clamp(walk_x, -POLICY_WALK_X_MAX, POLICY_WALK_X_MAX):.4f}")
        walk_x = _clamp(walk_x, -POLICY_WALK_X_MAX, POLICY_WALK_X_MAX)
    if abs(walk_y) > POLICY_WALK_Y_MAX:
        reasons.append(f"walk_y clamped {walk_y:.4f}->{_clamp(walk_y, -POLICY_WALK_Y_MAX, POLICY_WALK_Y_MAX):.4f}")
        walk_y = _clamp(walk_y, -POLICY_WALK_Y_MAX, POLICY_WALK_Y_MAX)
    if abs(walk_yaw) > POLICY_WALK_YAW_MAX:
        reasons.append(f"walk_yaw clamped {walk_yaw:.2f}->{_clamp(walk_yaw, -POLICY_WALK_YAW_MAX, POLICY_WALK_YAW_MAX):.2f}")
        walk_yaw = _clamp(walk_yaw, -POLICY_WALK_YAW_MAX, POLICY_WALK_YAW_MAX)
    if walk_height < POLICY_WALK_HEIGHT_MIN or walk_height > POLICY_WALK_HEIGHT_MAX:
        reasons.append(f"walk_height clamped {walk_height:.4f}")
        walk_height = _clamp(walk_height, POLICY_WALK_HEIGHT_MIN, POLICY_WALK_HEIGHT_MAX)
    if walk_speed < POLICY_WALK_SPEED_MIN or walk_speed > POLICY_WALK_SPEED_MAX:
        reasons.append(f"walk_speed clamped {walk_speed}")
        walk_speed = _clamp(walk_speed, POLICY_WALK_SPEED_MIN, POLICY_WALK_SPEED_MAX)

    clamped["walk_x"] = walk_x
    clamped["walk_y"] = walk_y
    clamped["walk_yaw"] = walk_yaw
    clamped["walk_height"] = walk_height
    clamped["walk_speed"] = walk_speed

    # Head parameters (optional)
    if "head_pan" in action:
        head_pan = _num("head_pan", 0.0)
        if abs(head_pan) > POLICY_HEAD_PAN_MAX:
            reasons.append(f"head_pan clamped {head_pan:.3f}")
            head_pan = _clamp(head_pan, -POLICY_HEAD_PAN_MAX, POLICY_HEAD_PAN_MAX)
        clamped["head_pan"] = head_pan
    if "head_tilt" in action:
        head_tilt = _num("head_tilt", 0.0)
        if abs(head_tilt) > POLICY_HEAD_TILT_MAX:
            reasons.append(f"head_tilt clamped {head_tilt:.3f}")
            head_tilt = _clamp(head_tilt, -POLICY_HEAD_TILT_MAX, POLICY_HEAD_TILT_MAX)
        clamped["head_tilt"] = head_tilt

    # A fundamentally invalid action (NaN/inf/garbage) is rejected: allowed=False
    # and the clamped payload is forced to the safe neutral pose so a caller that
    # ignores `allowed` still sends nothing dangerous.
    if invalid:
        return PolicyGuardResult(
            allowed=False,
            reason="invalid action rejected: " + ", ".join(invalid)
            + ("; " + "; ".join(reasons) if reasons else ""),
            clamped=clamped,
        )

    return PolicyGuardResult(
        allowed=True,
        reason="; ".join(reasons) if reasons else "",
        clamped=clamped,
    )


def _clamp(value: float | int, lo: float | int, hi: float | int) -> float | int:
    if isinstance(value, int) and isinstance(lo, int) and isinstance(hi, int):
        return max(lo, min(hi, value))
    return max(float(lo), min(float(hi), float(value)))


@dataclass
class PolicyHeartbeatMonitor:
    """Tracks policy tick heartbeats and detects stale policy loops."""

    timeout_sec: float = 2.0
    _last_tick: float = 0.0

    def record_tick(self) -> None:
        self._last_tick = time.monotonic()

    def is_stale(self) -> bool:
        if self._last_tick == 0.0:
            return False  # Never started
        return (time.monotonic() - self._last_tick) > self.timeout_sec

    def age_sec(self) -> float:
        if self._last_tick == 0.0:
            return 0.0
        return time.monotonic() - self._last_tick

