"""Bridge protocol envelopes and strict validation helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from eliza_robot.bridge.types import JsonDict, JsonValue


def utc_now_iso() -> str:
    """Return an RFC3339-like UTC timestamp."""
    return datetime.now(tz=UTC).isoformat()


@dataclass(frozen=True)
class CommandEnvelope:
    """Inbound command sent by a websocket client."""

    request_id: str
    timestamp: str
    command: str
    payload: JsonDict
    preempt: bool = False

    def to_json(self) -> JsonDict:
        return {
            "type": "command",
            "request_id": self.request_id,
            "timestamp": self.timestamp,
            "command": self.command,
            "payload": self.payload,
            "preempt": self.preempt,
        }


@dataclass(frozen=True)
class ResponseEnvelope:
    """Bridge response to a command."""

    request_id: str
    timestamp: str
    ok: bool
    backend: str
    message: str
    data: JsonDict

    def to_json(self) -> JsonDict:
        return {
            "type": "response",
            "request_id": self.request_id,
            "timestamp": self.timestamp,
            "ok": self.ok,
            "backend": self.backend,
            "message": self.message,
            "data": self.data,
        }


@dataclass(frozen=True)
class EventEnvelope:
    """Asynchronous telemetry/event emission from backend."""

    event: str
    timestamp: str
    backend: str
    data: JsonDict

    def to_json(self) -> JsonDict:
        return {
            "type": "event",
            "event": self.event,
            "timestamp": self.timestamp,
            "backend": self.backend,
            "data": self.data,
        }


def _expect_dict(value: JsonValue, key: str) -> JsonDict:
    if not isinstance(value, dict):
        raise ValueError(f"'{key}' must be an object")
    return value


def _expect_str(value: JsonValue, key: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"'{key}' must be a string")
    if value == "":
        raise ValueError(f"'{key}' must not be empty")
    return value


VALID_COMMANDS = {
    # Baseline robot commands
    "walk.set",
    "walk.command",
    "action.play",
    "head.set",
    "servo.set",
    # Policy lifecycle commands
    "policy.start",
    "policy.stop",
    "policy.tick",
    "policy.status",
    # ASIMOV-1 native command API
    "asimov.mode",
    "asimov.velocity",
    "asimov.trajectory",
    # Profile / introspection
    "profile.describe",
    # Camera (unified across sim + real backends — sim returns rendered
    # head-camera RGB, real returns the last v4l2/ROS camera frame).
    "camera.snapshot",
}

VALID_EVENTS = {
    # Existing events
    "session.hello",
    "telemetry.basic",
    "safety.deadman_triggered",
    # Policy telemetry/safety events
    "telemetry.perception",
    "telemetry.policy",
    "safety.policy_guard",
    "policy.status",
}


def parse_command(raw: JsonDict) -> CommandEnvelope:
    """Validate and parse an inbound websocket payload into a command envelope."""
    envelope_type = raw.get("type")
    if envelope_type != "command":
        raise ValueError("payload must have type='command'")

    request_id = _expect_str(raw.get("request_id"), "request_id")
    timestamp = _expect_str(raw.get("timestamp"), "timestamp")
    command = _expect_str(raw.get("command"), "command")
    payload = _expect_dict(raw.get("payload", {}), "payload")
    preempt_value = raw.get("preempt", False)
    if not isinstance(preempt_value, bool):
        raise ValueError("'preempt' must be a boolean")
    return CommandEnvelope(
        request_id=request_id,
        timestamp=timestamp,
        command=command,
        payload=payload,
        preempt=preempt_value,
    )
