"""Command payload validation for unified bridge API."""

from __future__ import annotations

from eliza_robot.bridge.protocol import CommandEnvelope


def _require_number(payload: dict[str, object], key: str) -> float:
    value = payload.get(key)
    if not isinstance(value, int | float):
        raise ValueError(f"payload.{key} must be a number")
    return float(value)


def _require_string(payload: dict[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or value == "":
        raise ValueError(f"payload.{key} must be a non-empty string")
    return value


def validate_command_payload(command: CommandEnvelope) -> None:
    """Validate command payload shape and range."""
    payload = command.payload

    if command.command == "walk.set":
        speed = _require_number(payload, "speed")
        if int(speed) not in {1, 2, 3, 4}:
            raise ValueError("payload.speed must be one of 1,2,3,4")
        height = _require_number(payload, "height")
        if height < 0.015 or height > 0.06:
            raise ValueError("payload.height out of range 0.015..0.06")
        x_value = _require_number(payload, "x")
        y_value = _require_number(payload, "y")
        yaw_value = _require_number(payload, "yaw")
        if x_value < -0.05 or x_value > 0.05:
            raise ValueError("payload.x out of range -0.05..0.05")
        if y_value < -0.05 or y_value > 0.05:
            raise ValueError("payload.y out of range -0.05..0.05")
        if yaw_value < -10.0 or yaw_value > 10.0:
            raise ValueError("payload.yaw out of range -10..10")
        return

    if command.command == "walk.command":
        action = _require_string(payload, "action")
        if action not in {"start", "stop", "enable", "disable", "enable_control", "disable_control"}:
            raise ValueError("payload.action is not a supported walk command")
        return

    if command.command == "action.play":
        _ = _require_string(payload, "name")
        return

    if command.command == "head.set":
        pan = _require_number(payload, "pan")
        tilt = _require_number(payload, "tilt")
        duration = _require_number(payload, "duration")
        if pan < -1.5 or pan > 1.5:
            raise ValueError("payload.pan out of range -1.5..1.5 rad")
        if tilt < -1.0 or tilt > 1.0:
            raise ValueError("payload.tilt out of range -1.0..1.0 rad")
        if duration <= 0.0 or duration > 5.0:
            raise ValueError("payload.duration out of range (0..5]")
        return

    if command.command == "servo.set":
        duration = _require_number(payload, "duration")
        if duration <= 0.0 or duration > 5.0:
            raise ValueError("payload.duration out of range (0..5]")
        positions_value = payload.get("positions")
        if not isinstance(positions_value, list):
            raise ValueError("payload.positions must be a list")
        if len(positions_value) == 0:
            raise ValueError("payload.positions must not be empty")
        for i, item in enumerate(positions_value):
            if not isinstance(item, dict):
                raise ValueError(f"payload.positions[{i}] must be an object")
            item_id = item.get("id")
            if not isinstance(item_id, int | float):
                raise ValueError(f"payload.positions[{i}].id must be a number")
            sid = int(item_id)
            if sid < 1 or sid > 24:
                raise ValueError(f"payload.positions[{i}].id out of range 1..24")
            item_pos = item.get("position")
            if not isinstance(item_pos, int | float):
                raise ValueError(f"payload.positions[{i}].position must be a number")
            if int(item_pos) < 0 or int(item_pos) > 1000:
                raise ValueError(f"payload.positions[{i}].position out of range 0..1000")
        return

    if command.command == "policy.start":
        _require_string(payload, "task")
        # Optional: model, hz, max_steps
        if "hz" in payload:
            hz = _require_number(payload, "hz")
            if hz < 1.0 or hz > 30.0:
                raise ValueError("payload.hz out of range 1..30")
        if "max_steps" in payload:
            max_steps = _require_number(payload, "max_steps")
            if max_steps < 1 or max_steps > 100000:
                raise ValueError("payload.max_steps out of range 1..100000")
        return

    if command.command == "policy.stop":
        # Optional: reason string
        return

    if command.command == "policy.tick":
        # Tick carries the observation + action chunk from/to OpenPI
        # Validated at adapter level, not here
        return

    if command.command == "policy.status":
        # Status query, no required payload
        return

    if command.command == "profile.describe":
        # Optional 'id' overrides the bridge's active profile.
        if "id" in payload:
            _require_string(payload, "id")
        return

    if command.command == "camera.snapshot":
        # No required payload. Optional `camera` selects a non-default camera
        # if the backend exposes multiple (head, overhead, etc.).
        if "camera" in payload:
            _require_string(payload, "camera")
        return

    raise ValueError(f"unsupported command: {command.command}")

