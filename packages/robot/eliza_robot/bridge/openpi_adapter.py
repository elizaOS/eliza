"""Custom AiNex OpenPI observation/action adapter.

Translates between AiNex perception/telemetry and the OpenPI policy server
wire format.  Enforces schema validation and deterministic defaulting for
missing signals so the policy always receives a well-formed observation and
the robot always receives a bounded command.
"""

from __future__ import annotations

import logging

from eliza_robot.interfaces import (
    AinexPerceptionObservation,
    JsonValue,
    OpenPIActionChunk,
    OpenPIObservationPayload,
    TrackedEntity,
)
from eliza_robot.schema.canonical import (
    AINEX_ACTION_DIM,
    AINEX_ENTITY_SLOT_DIM,
    AINEX_PROPRIO_DIM,
    AINEX_SCHEMA_VERSION,
    AINEX_STATE_DIM,
    BATTERY_MAX,
    BATTERY_MIN,
    HEAD_PAN_RANGE,
    HEAD_TILT_RANGE,
    IMU_RANGE,
    WALK_HEIGHT_MAX,
    WALK_HEIGHT_MIN,
    WALK_SPEED_MAX,
    WALK_SPEED_MIN,
    WALK_X_RANGE,
    WALK_Y_RANGE,
    WALK_YAW_RANGE,
    canonical_entity_slots,
    clamp_value,
    denormalize_value,
    normalize_value,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Observation builder
# ---------------------------------------------------------------------------

def build_observation(
    perception: AinexPerceptionObservation,
) -> OpenPIObservationPayload:
    """Convert an AiNex perception snapshot into an OpenPI observation payload."""

    proprio = (
        normalize_value(perception.walk_x, -WALK_X_RANGE, WALK_X_RANGE),
        normalize_value(perception.walk_y, -WALK_Y_RANGE, WALK_Y_RANGE),
        normalize_value(perception.walk_yaw, -WALK_YAW_RANGE, WALK_YAW_RANGE),
        normalize_value(perception.walk_height, WALK_HEIGHT_MIN, WALK_HEIGHT_MAX),
        normalize_value(float(perception.walk_speed), float(WALK_SPEED_MIN), float(WALK_SPEED_MAX)),
        normalize_value(perception.head_pan, -HEAD_PAN_RANGE, HEAD_PAN_RANGE),
        normalize_value(perception.head_tilt, -HEAD_TILT_RANGE, HEAD_TILT_RANGE),
        normalize_value(perception.imu_roll, -IMU_RANGE, IMU_RANGE),
        normalize_value(perception.imu_pitch, -IMU_RANGE, IMU_RANGE),
        1.0 if perception.is_walking else -1.0,
        normalize_value(float(perception.battery_mv), float(BATTERY_MIN), float(BATTERY_MAX)),
    )

    # Entity slots (already normalized to [-1, 1] by slot encoder)
    if perception.entity_slots and len(perception.entity_slots) == AINEX_ENTITY_SLOT_DIM:
        entity_slots = tuple(perception.entity_slots)
    else:
        if perception.entity_slots:
            logger.warning(
                "entity_slots has %d dims, expected %d; canonicalizing length",
                len(perception.entity_slots), AINEX_ENTITY_SLOT_DIM,
            )
            entity_slots = canonical_entity_slots(perception.entity_slots)
        else:
            entity_slots = canonical_entity_slots(())

    state = proprio + entity_slots

    metadata: dict[str, JsonValue] = {
        "schema_version": AINEX_SCHEMA_VERSION,
        "timestamp": perception.timestamp,
        "battery_mv": perception.battery_mv,
    }
    if perception.tracked_entities:
        metadata["entities"] = [
            {
                "id": e.entity_id,
                "label": e.label,
                "confidence": e.confidence,
                "xyz": [e.x, e.y, e.z],
            }
            for e in perception.tracked_entities
        ]

    return OpenPIObservationPayload(
        state=state,
        prompt=perception.language_instruction,
        image=perception.camera_frame,
        metadata=metadata,
        schema_version=perception.schema_version,
    )


def observation_to_dict(obs: OpenPIObservationPayload) -> dict[str, JsonValue]:
    """Serialize an observation payload to a dict suitable for the OpenPI client."""
    d: dict[str, JsonValue] = {
        "state": list(obs.state),
        "prompt": obs.prompt,
        "schema_version": obs.schema_version,
    }
    if obs.image:
        d["image"] = obs.image
    if obs.metadata:
        d["metadata"] = obs.metadata
    return d


# ---------------------------------------------------------------------------
# Action decoder
# ---------------------------------------------------------------------------

def decode_action(raw: dict[str, JsonValue]) -> OpenPIActionChunk:
    """Decode an OpenPI action response into an AiNex action chunk.

    Accepts either:
    - A dict with an ``action`` key containing a list of floats (raw vector)
    - A dict with explicit named fields (walk_x, walk_y, etc.)
    """
    confidence = float(raw.get("confidence", 1.0))

    action_vector = raw.get("action")
    if isinstance(action_vector, (list, tuple)) and len(action_vector) < AINEX_ACTION_DIM:
        raise ValueError(
            f"OpenPI action vector has {len(action_vector)} dimensions; expected at least {AINEX_ACTION_DIM}"
        )
    if isinstance(action_vector, (list, tuple)) and len(action_vector) >= AINEX_ACTION_DIM:
        # Raw action vector from policy: decode positionally
        av = [float(v) for v in action_vector]
        walk_x = clamp_value(denormalize_value(av[0], -WALK_X_RANGE, WALK_X_RANGE), -WALK_X_RANGE, WALK_X_RANGE)
        walk_y = clamp_value(denormalize_value(av[1], -WALK_Y_RANGE, WALK_Y_RANGE), -WALK_Y_RANGE, WALK_Y_RANGE)
        walk_yaw = clamp_value(denormalize_value(av[2], -WALK_YAW_RANGE, WALK_YAW_RANGE), -WALK_YAW_RANGE, WALK_YAW_RANGE)
        walk_height = clamp_value(denormalize_value(av[3], WALK_HEIGHT_MIN, WALK_HEIGHT_MAX), WALK_HEIGHT_MIN, WALK_HEIGHT_MAX)
        walk_speed = int(round(clamp_value(denormalize_value(av[4], float(WALK_SPEED_MIN), float(WALK_SPEED_MAX)), float(WALK_SPEED_MIN), float(WALK_SPEED_MAX))))
        head_pan = clamp_value(denormalize_value(av[5], -HEAD_PAN_RANGE, HEAD_PAN_RANGE), -HEAD_PAN_RANGE, HEAD_PAN_RANGE)
        head_tilt = clamp_value(denormalize_value(av[6], -HEAD_TILT_RANGE, HEAD_TILT_RANGE), -HEAD_TILT_RANGE, HEAD_TILT_RANGE)

        return OpenPIActionChunk(
            raw_action=tuple(av),
            walk_x=walk_x,
            walk_y=walk_y,
            walk_yaw=walk_yaw,
            walk_height=walk_height,
            walk_speed=walk_speed,
            head_pan=head_pan,
            head_tilt=head_tilt,
            confidence=confidence,
            schema_version=AINEX_SCHEMA_VERSION,
        )

    # Named-field format (e.g., from a structured policy)
    return OpenPIActionChunk(
        walk_x=clamp_value(float(raw.get("walk_x", 0.0)), -WALK_X_RANGE, WALK_X_RANGE),
        walk_y=clamp_value(float(raw.get("walk_y", 0.0)), -WALK_Y_RANGE, WALK_Y_RANGE),
        walk_yaw=clamp_value(float(raw.get("walk_yaw", 0.0)), -WALK_YAW_RANGE, WALK_YAW_RANGE),
        walk_height=clamp_value(float(raw.get("walk_height", 0.036)), WALK_HEIGHT_MIN, WALK_HEIGHT_MAX),
        walk_speed=int(round(clamp_value(float(raw.get("walk_speed", 2)), float(WALK_SPEED_MIN), float(WALK_SPEED_MAX)))),
        head_pan=clamp_value(float(raw.get("head_pan", 0.0)), -HEAD_PAN_RANGE, HEAD_PAN_RANGE),
        head_tilt=clamp_value(float(raw.get("head_tilt", 0.0)), -HEAD_TILT_RANGE, HEAD_TILT_RANGE),
        action_name=str(raw.get("action_name", "")),
        confidence=confidence,
        schema_version=str(raw.get("schema_version", AINEX_SCHEMA_VERSION)),
    )


def action_to_bridge_commands(action: OpenPIActionChunk) -> list[dict[str, Any]]:
    """Convert an OpenPI action chunk into a list of bridge command payloads.

    Returns one or more command dicts ready to be sent as CommandEnvelope payloads.
    """
    commands: list[dict[str, Any]] = []

    # Walk set command
    commands.append({
        "command": "walk.set",
        "payload": {
            "speed": action.walk_speed,
            "height": action.walk_height,
            "x": action.walk_x,
            "y": action.walk_y,
            "yaw": action.walk_yaw,
        },
    })

    # Head set command (only if non-zero)
    if action.head_pan != 0.0 or action.head_tilt != 0.0:
        commands.append({
            "command": "head.set",
            "payload": {
                "pan": action.head_pan,
                "tilt": action.head_tilt,
                "duration": 0.1,  # Fast tracking during policy mode
            },
        })

    # Named action (only if specified)
    if action.action_name:
        commands.append({
            "command": "action.play",
            "payload": {
                "name": action.action_name,
            },
        })

    return commands


# ---------------------------------------------------------------------------
# Default / fallback observation (for when perception is unavailable)
# ---------------------------------------------------------------------------

def default_perception() -> AinexPerceptionObservation:
    """Return a safe default perception with all values at neutral."""
    return AinexPerceptionObservation(
        timestamp=0.0,
        battery_mv=12000,
        imu_roll=0.0,
        imu_pitch=0.0,
        is_walking=False,
        walk_x=0.0,
        walk_y=0.0,
        walk_yaw=0.0,
        walk_height=0.036,
        walk_speed=2,
        head_pan=0.0,
        head_tilt=0.0,
        schema_version=AINEX_SCHEMA_VERSION,
    )
