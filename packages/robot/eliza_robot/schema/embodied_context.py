"""Canonical EmbodiedContext schema -- single source of truth for world state.

This module defines a lightweight, environment-agnostic representation of the
world that is shared across Hyperscape (game), MuJoCo (simulation), and the
real AiNex robot.  Every perception pipeline, planner, and policy adapter
consumes or produces instances of ``EmbodiedContext``.

Design choices
--------------
* **dataclasses, not Pydantic** -- keep it zero-dependency and fast to
  construct / copy in hot loops.
* **Tuples for immutable collections** -- positions, entities, entity_slots
  are all tuples so a snapshot is frozen by default.
* **Factory classmethods** live here so that each adapter (real robot, MuJoCo,
  Hyperscape) can build a canonical context from its native representation.
"""

from __future__ import annotations

import math
import time
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    MAX_DISTANCE,
    MAX_SIZE,
    MAX_VELOCITY,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    RECENCY_HORIZON,
    RECENCY_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
    EntityType as SlotEntityType,
)
from eliza_robot.schema.canonical import AINEX_SCHEMA_VERSION

# NOTE: Depends on packages/robot/eliza_robot/bridge/ which is being ported in
# parallel (W3.1).  The TYPE_CHECKING-only import below may fail at runtime
# until the bridge port lands; consumers should not rely on it yet.
if TYPE_CHECKING:
    from eliza_robot.bridge.perception import PerceptionAggregator

# ── Entity type constants ────────────────────────────────────────────────
ENTITY_TYPE_STRINGS: tuple[str, ...] = (
    "unknown",
    "person",
    "object",
    "landmark",
    "furniture",
    "door",
)


def _entity_type_to_slot_index(entity_type: str) -> int:
    """Map a string entity type to its one-hot index in SlotEntityType."""
    try:
        return ENTITY_TYPE_STRINGS.index(entity_type.lower())
    except ValueError:
        return 0  # unknown


# ── ContextEntity ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ContextEntity:
    """A normalised entity in the world, agnostic to source environment."""

    entity_id: str
    entity_type: str  # "person", "object", "landmark", "furniture", "door", "unknown"
    label: str  # semantic label: "red_ball", "table", "person_1"
    position: tuple[float, float, float] = (0.0, 0.0, 0.0)  # world frame (x, y, z) metres
    velocity: tuple[float, float, float] = (0.0, 0.0, 0.0)  # world frame m/s
    size: tuple[float, float, float] = (0.0, 0.0, 0.0)  # (width, height, depth) metres
    confidence: float = 0.0  # [0, 1]
    distance_to_agent: float = 0.0  # metres
    bearing_to_agent: float = 0.0  # radians, 0 = directly ahead
    source: str = ""  # "ego_camera", "external_camera", "simulation", "game"
    properties: dict[str, Any] = field(default_factory=dict)

    # -- helpers ----------------------------------------------------------

    def bearing_description(self) -> str:
        """Human-readable bearing text relative to the agent."""
        deg = math.degrees(self.bearing_to_agent)
        if abs(deg) < 15:
            return "ahead"
        if deg > 0:
            return f"{abs(deg):.0f}deg to the left" if deg < 90 else "to the left"
        return f"{abs(deg):.0f}deg to the right" if deg > -90 else "to the right"

    def to_dict(self) -> dict[str, Any]:
        """Serialise to a plain dict."""
        d = asdict(self)  # type: ignore[arg-type]
        # Convert tuples to lists for JSON compat
        for key in ("position", "velocity", "size"):
            d[key] = list(d[key])
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ContextEntity:
        """Deserialise from a plain dict."""
        return cls(
            entity_id=str(d.get("entity_id", "")),
            entity_type=str(d.get("entity_type", "unknown")),
            label=str(d.get("label", "")),
            position=tuple(d.get("position", (0.0, 0.0, 0.0))),  # type: ignore[arg-type]
            velocity=tuple(d.get("velocity", (0.0, 0.0, 0.0))),  # type: ignore[arg-type]
            size=tuple(d.get("size", (0.0, 0.0, 0.0))),  # type: ignore[arg-type]
            confidence=float(d.get("confidence", 0.0)),
            distance_to_agent=float(d.get("distance_to_agent", 0.0)),
            bearing_to_agent=float(d.get("bearing_to_agent", 0.0)),
            source=str(d.get("source", "")),
            properties=dict(d.get("properties", {})),
        )


# ── EmbodiedContext ──────────────────────────────────────────────────────

@dataclass
class EmbodiedContext:
    """Universal world state representation across all environments.

    This is the **single source of truth** consumed by:
    * LLM planners (via ``to_llm_prompt()``)
    * RL policies  (via ``to_entity_slots_array()``)
    * TrajectoryDB (via ``to_dict()``)
    """

    # Identity
    schema_version: str = "1.0"
    source: str = ""  # "mujoco", "hyperscape", "real_robot"
    timestamp: float = 0.0

    # Agent proprioception
    agent_position: tuple[float, float, float] = (0.0, 0.0, 0.0)  # world frame
    agent_orientation: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0)  # quaternion (x,y,z,w)
    agent_yaw: float = 0.0  # heading in world frame (radians)
    imu_roll: float = 0.0
    imu_pitch: float = 0.0
    gyro: tuple[float, float, float] = (0.0, 0.0, 0.0)
    is_walking: bool = False
    battery_mv: int = 0
    joint_positions: tuple[float, ...] = ()  # 24-dim for full body

    # Scene entities (high-level)
    entities: tuple[ContextEntity, ...] = ()

    # Entity slots (152-dim, for RL policy input)
    entity_slots: tuple[float, ...] = ()

    # Task context
    task_description: str = ""
    language_instruction: str = ""

    # Camera (optional, base64 encoded)
    ego_camera_b64: str = ""
    external_camera_b64: str = ""

    # ── serialisation ────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        """Serialise to dict compatible with TrajectoryDB.insert_embodied_context().

        Returns a plain JSON-serialisable dict.  Tuples become lists, entities
        become dicts, and numpy arrays (if any sneak in) become lists.
        """
        return {
            "schema_version": self.schema_version,
            "source": self.source,
            "timestamp": self.timestamp,
            "agent_position": list(self.agent_position),
            "agent_orientation": list(self.agent_orientation),
            "agent_yaw": self.agent_yaw,
            "imu_roll": self.imu_roll,
            "imu_pitch": self.imu_pitch,
            "gyro": list(self.gyro),
            "is_walking": self.is_walking,
            "battery_mv": self.battery_mv,
            "joint_positions": list(self.joint_positions),
            "entities": [e.to_dict() for e in self.entities],
            "entity_slots": list(self.entity_slots),
            "task_description": self.task_description,
            "language_instruction": self.language_instruction,
            "ego_camera_b64": self.ego_camera_b64,
            "external_camera_b64": self.external_camera_b64,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EmbodiedContext:
        """Reconstruct from a dict produced by ``to_dict()``."""
        entities_raw = d.get("entities", [])
        entities = tuple(
            ContextEntity.from_dict(e) if isinstance(e, dict) else e
            for e in entities_raw
        )
        return cls(
            schema_version=str(d.get("schema_version", "1.0")),
            source=str(d.get("source", "")),
            timestamp=float(d.get("timestamp", 0.0)),
            agent_position=tuple(d.get("agent_position", (0.0, 0.0, 0.0))),  # type: ignore[arg-type]
            agent_orientation=tuple(d.get("agent_orientation", (0.0, 0.0, 0.0, 1.0))),  # type: ignore[arg-type]
            agent_yaw=float(d.get("agent_yaw", 0.0)),
            imu_roll=float(d.get("imu_roll", 0.0)),
            imu_pitch=float(d.get("imu_pitch", 0.0)),
            gyro=tuple(d.get("gyro", (0.0, 0.0, 0.0))),  # type: ignore[arg-type]
            is_walking=bool(d.get("is_walking", False)),
            battery_mv=int(d.get("battery_mv", 0)),
            joint_positions=tuple(d.get("joint_positions", ())),
            entities=entities,
            entity_slots=tuple(d.get("entity_slots", ())),
            task_description=str(d.get("task_description", "")),
            language_instruction=str(d.get("language_instruction", "")),
            ego_camera_b64=str(d.get("ego_camera_b64", "")),
            external_camera_b64=str(d.get("external_camera_b64", "")),
        )

    # ── LLM prompt ───────────────────────────────────────────────────

    def to_llm_prompt(self) -> str:
        """Format the context as natural language for LLM prompt injection.

        Example output::

            You are a humanoid robot. Nearby entities: red_ball (object,
            1.5m ahead), table (furniture, 2.0m to the left). You are walking.
        """
        parts: list[str] = ["You are a humanoid robot."]

        # Entities
        if self.entities:
            descs: list[str] = []
            for e in self.entities:
                dist_str = f"{e.distance_to_agent:.1f}m"
                bearing_str = e.bearing_description()
                descs.append(f"{e.label} ({e.entity_type}, {dist_str} {bearing_str})")
            parts.append("Nearby entities: " + ", ".join(descs) + ".")

        # Walking state
        if self.is_walking:
            parts.append("You are walking.")
        else:
            parts.append("You are standing still.")

        # Battery
        if self.battery_mv > 0:
            parts.append(f"Battery: {self.battery_mv}mV.")

        # Task
        if self.task_description:
            parts.append(f"Current task: {self.task_description}")
        if self.language_instruction:
            parts.append(f"Instruction: {self.language_instruction}")

        return " ".join(parts)

    # ── RL policy array ──────────────────────────────────────────────

    def to_entity_slots_array(self) -> np.ndarray:
        """Extract 152-dim entity slots as a numpy array for RL policy input.

        If ``self.entity_slots`` is already populated (e.g. from the
        perception pipeline), it is returned directly.  Otherwise the method
        encodes ``self.entities`` into the canonical slot format.
        """
        if self.entity_slots and len(self.entity_slots) == TOTAL_ENTITY_DIMS:
            return np.array(self.entity_slots, dtype=np.float32)

        slots = np.zeros(TOTAL_ENTITY_DIMS, dtype=np.float32)
        for i, entity in enumerate(self.entities[:NUM_ENTITY_SLOTS]):
            offset = i * SLOT_DIM
            # One-hot entity type
            type_idx = _entity_type_to_slot_index(entity.entity_type)
            if 0 <= type_idx < NUM_ENTITY_TYPES:
                slots[offset + TYPE_OFFSET + type_idx] = 1.0
            # Position (normalised)
            slots[offset + POSITION_OFFSET] = entity.position[0] / MAX_DISTANCE
            slots[offset + POSITION_OFFSET + 1] = entity.position[1] / MAX_DISTANCE
            slots[offset + POSITION_OFFSET + 2] = entity.position[2] / MAX_DISTANCE
            # Velocity (normalised)
            slots[offset + VELOCITY_OFFSET] = entity.velocity[0] / MAX_VELOCITY
            slots[offset + VELOCITY_OFFSET + 1] = entity.velocity[1] / MAX_VELOCITY
            slots[offset + VELOCITY_OFFSET + 2] = entity.velocity[2] / MAX_VELOCITY
            # Size (normalised)
            slots[offset + SIZE_OFFSET] = entity.size[0] / MAX_SIZE
            slots[offset + SIZE_OFFSET + 1] = entity.size[1] / MAX_SIZE
            slots[offset + SIZE_OFFSET + 2] = entity.size[2] / MAX_SIZE
            # Confidence
            slots[offset + CONFIDENCE_OFFSET] = entity.confidence
            # Recency -- entities inside EmbodiedContext are snapshot-time, so 0
            slots[offset + RECENCY_OFFSET] = 0.0
            # Bearing (sin, cos)
            slots[offset + BEARING_OFFSET] = math.sin(entity.bearing_to_agent)
            slots[offset + BEARING_OFFSET + 1] = math.cos(entity.bearing_to_agent)
        return slots

    # ── Factory: real robot via PerceptionAggregator ─────────────────

    @classmethod
    def from_perception_aggregator(
        cls,
        agg: PerceptionAggregator,
        robot_world_pose: dict[str, Any] | None = None,
        language_instruction: str = "",
        camera_frame: str = "",
    ) -> EmbodiedContext:
        """Build from the robot's :class:`PerceptionAggregator`.

        Parameters
        ----------
        agg:
            A live PerceptionAggregator instance.
        robot_world_pose:
            Optional dict with ``position`` (x,y,z), ``orientation`` (x,y,z,w)
            and ``yaw`` keys from an external localisation source.
        language_instruction:
            Current task instruction.
        camera_frame:
            Base64-encoded ego camera JPEG, if available.
        """
        snap = agg.snapshot(
            language_instruction=language_instruction,
            camera_frame=camera_frame,
        )
        summary = agg.scene_summary()

        # Build ContextEntity list from tracked entities + summary
        context_entities: list[ContextEntity] = []
        summary_map: dict[str, dict[str, Any]] = {}
        for se in summary.get("entities", []):
            summary_map[se["id"]] = se

        for te in snap.tracked_entities:
            se = summary_map.get(te.entity_id, {})
            pos = (te.x, te.y, te.z)
            dist = math.sqrt(te.x ** 2 + te.y ** 2 + te.z ** 2)
            bearing = math.atan2(te.y, te.x) if (te.x != 0 or te.y != 0) else 0.0
            etype = _label_to_entity_type(te.label)
            context_entities.append(ContextEntity(
                entity_id=te.entity_id,
                entity_type=etype,
                label=te.label,
                position=pos,
                velocity=(0.0, 0.0, 0.0),
                size=(0.0, 0.0, 0.0),
                confidence=te.confidence,
                distance_to_agent=dist,
                bearing_to_agent=bearing,
                source="ego_camera",
                properties={"age_sec": se.get("age_sec", 0.0)} if se else {},
            ))

        # Robot world pose
        rp = robot_world_pose or {}
        agent_pos = tuple(rp.get("position", (0.0, 0.0, 0.0)))
        agent_ori = tuple(rp.get("orientation", (0.0, 0.0, 0.0, 1.0)))
        agent_yaw = float(rp.get("yaw", 0.0))

        return cls(
            schema_version="1.0",
            source="real_robot",
            timestamp=snap.timestamp,
            agent_position=agent_pos,  # type: ignore[arg-type]
            agent_orientation=agent_ori,  # type: ignore[arg-type]
            agent_yaw=agent_yaw,
            imu_roll=snap.imu_roll,
            imu_pitch=snap.imu_pitch,
            gyro=(0.0, 0.0, 0.0),
            is_walking=snap.is_walking,
            battery_mv=snap.battery_mv,
            joint_positions=(),
            entities=tuple(context_entities),
            entity_slots=snap.entity_slots,
            task_description="",
            language_instruction=language_instruction,
            ego_camera_b64=camera_frame,
            external_camera_b64="",
        )

    # ── Factory: MuJoCo simulation ───────────────────────────────────

    @classmethod
    def from_mujoco(
        cls,
        data: Any,
        model: Any,
        entity_info: list[dict[str, Any]],
        entity_slots: np.ndarray,
        task_description: str = "",
        language_instruction: str = "",
    ) -> EmbodiedContext:
        """Build from MuJoCo simulation state.

        Parameters
        ----------
        data:
            ``mujoco.MjData`` instance.
        model:
            ``mujoco.MjModel`` instance.
        entity_info:
            List of dicts describing each entity with at least ``entity_id``,
            ``label``, ``entity_type``, ``position`` (3-list), and optionally
            ``velocity``, ``size``.
        entity_slots:
            Pre-encoded 152-dim entity slot array from sim observation builder.
        task_description:
            Human-readable task description for this episode.
        language_instruction:
            Instruction string for the policy.
        """
        # Extract agent state from MuJoCo data
        agent_pos = (0.0, 0.0, 0.0)
        agent_ori = (0.0, 0.0, 0.0, 1.0)
        agent_yaw = 0.0
        joint_pos: tuple[float, ...] = ()
        imu_roll = 0.0
        imu_pitch = 0.0
        gyro = (0.0, 0.0, 0.0)

        try:
            # Attempt to read qpos for the robot root body
            if hasattr(data, "qpos") and len(data.qpos) >= 7:
                agent_pos = (float(data.qpos[0]), float(data.qpos[1]), float(data.qpos[2]))
                agent_ori = (
                    float(data.qpos[3]),
                    float(data.qpos[4]),
                    float(data.qpos[5]),
                    float(data.qpos[6]),
                )
                # Yaw from quaternion -- MuJoCo stores (w, x, y, z) in qpos[3:7]
                qw, qx, qy, qz = agent_ori
                agent_yaw = math.atan2(
                    2.0 * (qw * qz + qx * qy),
                    1.0 - 2.0 * (qy * qy + qz * qz),
                )
            if hasattr(data, "qpos") and len(data.qpos) > 7:
                joint_pos = tuple(float(v) for v in data.qpos[7:])
            # IMU from sensordata if available
            if hasattr(data, "sensordata") and len(data.sensordata) >= 3:
                gyro = (
                    float(data.sensordata[0]),
                    float(data.sensordata[1]),
                    float(data.sensordata[2]),
                )
        except (IndexError, AttributeError):
            pass

        # Build ContextEntity list
        context_entities: list[ContextEntity] = []
        for info in entity_info:
            pos = tuple(info.get("position", (0.0, 0.0, 0.0)))
            vel = tuple(info.get("velocity", (0.0, 0.0, 0.0)))
            sz = tuple(info.get("size", (0.0, 0.0, 0.0)))
            # Distance and bearing relative to agent
            dx = pos[0] - agent_pos[0]
            dy = pos[1] - agent_pos[1]
            dz = pos[2] - agent_pos[2]
            dist = math.sqrt(dx * dx + dy * dy + dz * dz)
            # Bearing in agent frame (subtract agent_yaw)
            world_bearing = math.atan2(dy, dx)
            bearing = _normalize_angle(world_bearing - agent_yaw)

            context_entities.append(ContextEntity(
                entity_id=str(info.get("entity_id", "")),
                entity_type=str(info.get("entity_type", "unknown")),
                label=str(info.get("label", "")),
                position=pos,  # type: ignore[arg-type]
                velocity=vel,  # type: ignore[arg-type]
                size=sz,  # type: ignore[arg-type]
                confidence=float(info.get("confidence", 1.0)),
                distance_to_agent=dist,
                bearing_to_agent=bearing,
                source="simulation",
                properties=dict(info.get("properties", {})),
            ))

        slots = tuple(float(v) for v in entity_slots.flat[:TOTAL_ENTITY_DIMS])

        return cls(
            schema_version="1.0",
            source="mujoco",
            timestamp=float(data.time) if hasattr(data, "time") else time.time(),
            agent_position=agent_pos,
            agent_orientation=agent_ori,
            agent_yaw=agent_yaw,
            imu_roll=imu_roll,
            imu_pitch=imu_pitch,
            gyro=gyro,
            is_walking=False,
            battery_mv=0,
            joint_positions=joint_pos,
            entities=tuple(context_entities),
            entity_slots=slots,
            task_description=task_description,
            language_instruction=language_instruction,
            ego_camera_b64="",
            external_camera_b64="",
        )

    # ── Factory: Hyperscape game snapshot ────────────────────────────

    @classmethod
    def from_hyperscape_snapshot(cls, snapshot: dict[str, Any]) -> EmbodiedContext:
        """Build from a Hyperscape game world snapshot.

        Delegates entity mapping to :mod:`eliza_robot.schema.hyperscape_adapter`.
        The snapshot dict is expected to arrive from the TypeScript side with
        camelCase keys.
        """
        from eliza_robot.schema.hyperscape_adapter import (
            adapt_hyperscape_entities,
            transform_game_position,
        )

        ts = float(snapshot.get("timestamp", snapshot.get("time", time.time())))

        # Agent / player state
        player = snapshot.get("player", snapshot.get("agent", {}))
        raw_pos = player.get("position", player.get("pos", [0, 0, 0]))
        agent_pos = transform_game_position(raw_pos)

        raw_ori = player.get("orientation", player.get("rotation", [0, 0, 0, 1]))
        agent_ori = tuple(float(v) for v in raw_ori)
        if len(agent_ori) != 4:
            agent_ori = (0.0, 0.0, 0.0, 1.0)

        agent_yaw = float(player.get("yaw", player.get("heading", 0.0)))
        is_walking = bool(player.get("isWalking", player.get("isMoving", False)))

        # Entities
        raw_entities = snapshot.get("entities", snapshot.get("objects", []))
        context_entities = adapt_hyperscape_entities(raw_entities, agent_pos, agent_yaw)

        # Task
        task_desc = str(snapshot.get("taskDescription", snapshot.get("task", "")))
        lang_inst = str(snapshot.get("languageInstruction", snapshot.get("instruction", "")))

        return cls(
            schema_version="1.0",
            source="hyperscape",
            timestamp=ts,
            agent_position=agent_pos,
            agent_orientation=agent_ori,  # type: ignore[arg-type]
            agent_yaw=agent_yaw,
            imu_roll=0.0,
            imu_pitch=0.0,
            gyro=(0.0, 0.0, 0.0),
            is_walking=is_walking,
            battery_mv=0,
            joint_positions=(),
            entities=tuple(context_entities),
            entity_slots=(),  # populated lazily via to_entity_slots_array()
            task_description=task_desc,
            language_instruction=lang_inst,
            ego_camera_b64="",
            external_camera_b64="",
        )


# ── Private helpers ──────────────────────────────────────────────────────

def _normalize_angle(angle: float) -> float:
    """Wrap angle to [-pi, pi]."""
    while angle > math.pi:
        angle -= 2.0 * math.pi
    while angle < -math.pi:
        angle += 2.0 * math.pi
    return angle


_LABEL_PERSON_KEYWORDS = {"person", "face", "human", "man", "woman", "child", "people"}
_LABEL_FURNITURE_KEYWORDS = {"chair", "couch", "bed", "dining table", "toilet", "bench", "desk", "table", "sofa"}
_LABEL_DOOR_KEYWORDS = {"door", "gate", "portal"}
_LABEL_LANDMARK_KEYWORDS = {"wall", "floor", "ceiling", "pillar", "column", "tree", "rock", "building"}


def _label_to_entity_type(label: str) -> str:
    """Infer entity type string from a detection label."""
    lower = label.lower()
    if lower in _LABEL_PERSON_KEYWORDS:
        return "person"
    if lower in _LABEL_FURNITURE_KEYWORDS:
        return "furniture"
    if lower in _LABEL_DOOR_KEYWORDS:
        return "door"
    if lower in _LABEL_LANDMARK_KEYWORDS:
        return "landmark"
    if lower == "unknown":
        return "unknown"
    return "object"
