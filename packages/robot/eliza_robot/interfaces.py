"""Typed interfaces for policy-vector runtime integration and OpenPI adapter I/O."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from eliza_robot.schema.canonical import AINEX_SCHEMA_VERSION

JsonPrimitive = str | int | float | bool | None
JsonValue = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]


# ---------------------------------------------------------------------------
# Existing policy-vector interfaces (preserved)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RobotObservation:
    timestamp: float
    battery_mv: int
    imu_roll: float
    imu_pitch: float
    is_walking: bool


@dataclass(frozen=True)
class PolicyVector:
    values: tuple[float, ...]


@dataclass(frozen=True)
class PolicyOutput:
    walk_x: float
    walk_y: float
    walk_yaw: float
    walk_height: float
    walk_speed: int
    action_name: str


class PolicyRuntime:
    """Interface expected by runtime bridge executors."""

    def infer(self, obs: RobotObservation, z: PolicyVector) -> PolicyOutput:
        raise NotImplementedError("policy runtime must implement infer()")


# ---------------------------------------------------------------------------
# Perception observation (feeds into OpenPI adapter + Eliza providers)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TrackedEntity:
    """A single tracked object/face/landmark from eliza_robot.perception."""
    entity_id: str
    label: str
    confidence: float
    x: float  # relative position in camera frame
    y: float
    z: float  # depth, 0.0 if unknown
    last_seen: float  # monotonic timestamp


@dataclass(frozen=True)
class AinexPerceptionObservation:
    """Aggregated perception state for the AiNex robot."""
    timestamp: float
    # Robot proprioception
    battery_mv: int
    imu_roll: float
    imu_pitch: float
    is_walking: bool
    walk_x: float
    walk_y: float
    walk_yaw: float
    walk_height: float
    walk_speed: int
    head_pan: float
    head_tilt: float
    # Scene perception
    tracked_entities: tuple[TrackedEntity, ...] = ()
    # Entity slots for RL policy (8 slots x 19 dims = 152)
    entity_slots: tuple[float, ...] = ()
    # Optional camera frame reference (base64-encoded JPEG or path)
    camera_frame: str = ""
    # Task/language instruction conditioning
    language_instruction: str = ""
    # Schema version for downstream consumers and trace readers
    schema_version: str = AINEX_SCHEMA_VERSION


# ---------------------------------------------------------------------------
# OpenPI observation / action payloads (wire format for openpi-client)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class OpenPIObservationPayload:
    """Observation dict sent to OpenPI inference server.

    Maps AiNex perception into the OpenPI observation schema.
    The exact field names follow the OpenPI convention for custom tasks.
    """
    # Proprioception vector (normalized)
    state: tuple[float, ...]
    # Language instruction for the task
    prompt: str
    # Optional image observation (base64 JPEG or numpy-compatible)
    image: str = ""
    # Extra metadata
    metadata: dict[str, JsonValue] = field(default_factory=dict)
    # Schema version for downstream consumers and trace readers
    schema_version: str = AINEX_SCHEMA_VERSION


@dataclass(frozen=True)
class OpenPIActionChunk:
    """Action output from OpenPI inference.

    Contains the raw action vector plus decoded AiNex-specific fields.
    """
    # Raw action vector from the policy
    raw_action: tuple[float, ...] = ()
    # Decoded AiNex walk/head controls
    walk_x: float = 0.0
    walk_y: float = 0.0
    walk_yaw: float = 0.0
    walk_height: float = 0.036
    walk_speed: int = 2
    head_pan: float = 0.0
    head_tilt: float = 0.0
    # Optional named action to play
    action_name: str = ""
    # Confidence from the policy (0..1)
    confidence: float = 1.0
    # Schema version for downstream consumers and trace readers
    schema_version: str = AINEX_SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Policy lifecycle records (for logging/training)
# ---------------------------------------------------------------------------

class PolicyState(Enum):
    IDLE = "idle"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    FAILED = "failed"


class CanonicalIntentType(Enum):
    NAVIGATE_TO_ENTITY = "NAVIGATE_TO_ENTITY"
    NAVIGATE_TO_POSITION = "NAVIGATE_TO_POSITION"
    FACE_ENTITY = "FACE_ENTITY"
    PICKUP_ENTITY = "PICKUP_ENTITY"
    EMOTE = "EMOTE"
    SPEAK = "SPEAK"
    IDLE = "IDLE"
    ABORT = "ABORT"


@dataclass(frozen=True)
class PlannerTraceContext:
    """Identifiers that link planner and executor traces."""
    trace_id: str = ""
    planner_step_id: str = ""
    source: str = ""


@dataclass(frozen=True)
class CanonicalIntent:
    """Planner output shared across Hyperscape and robot execution."""
    intent: CanonicalIntentType
    target_entity_id: str = ""
    target_entity_label: str = ""
    target_position: tuple[float, float, float] = ()
    source_action_name: str = ""
    reasoning: str = ""
    constraints: tuple[str, ...] = ()


@dataclass(frozen=True)
class ExecutorRequest:
    """Request sent from the planner layer to the embodied executor."""
    planner: PlannerTraceContext = field(default_factory=PlannerTraceContext)
    task_text: str = ""
    canonical_intent: CanonicalIntent = field(
        default_factory=lambda: CanonicalIntent(intent=CanonicalIntentType.IDLE)
    )
    entity_slots: tuple[float, ...] = ()
    metadata: dict[str, JsonValue] = field(default_factory=dict)
    schema_version: str = AINEX_SCHEMA_VERSION


@dataclass(frozen=True)
class ExecutorResult:
    """Result emitted by the embodied executor back to the planner layer."""
    planner: PlannerTraceContext = field(default_factory=PlannerTraceContext)
    success: bool = False
    status: str = ""
    steps_completed: int = 0
    target_entity_id: str = ""
    metadata: dict[str, JsonValue] = field(default_factory=dict)
    schema_version: str = AINEX_SCHEMA_VERSION


@dataclass(frozen=True)
class PolicyTransitionRecord:
    """Record of a policy state transition, for trace logging and training datasets."""
    timestamp: float
    from_state: PolicyState
    to_state: PolicyState
    reason: str
    trace_id: str = ""
    planner_step_id: str = ""
    canonical_action: str = ""
    target_entity_id: str = ""
    target_label: str = ""
    task: str = ""
    step: int = 0
    # Snapshot of observation at transition
    observation_summary: dict[str, JsonValue] = field(default_factory=dict)
    # Snapshot of last action at transition
    action_summary: dict[str, JsonValue] = field(default_factory=dict)
    # Latency metrics
    tick_latency_ms: float = 0.0
    inference_latency_ms: float = 0.0

