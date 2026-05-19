"""Lightweight perception aggregator for AiNex.

Accepts object/face/SLAM feeds and publishes a unified scene state
(tracked entities + confidence + recency).  Feeds both Eliza providers
and the OpenPI observation builder.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from eliza_robot.perception.entity_slots.slot_config import TOTAL_ENTITY_DIMS
from eliza_robot.interfaces import AinexPerceptionObservation, TrackedEntity
from eliza_robot.schema.canonical import AINEX_SCHEMA_VERSION, canonical_entity_slots


@dataclass
class _InternalEntity:
    entity_id: str
    label: str
    confidence: float
    x: float
    y: float
    z: float
    last_seen: float
    source: str  # "object", "face", "slam"


class PerceptionAggregator:
    """Single-writer perception state aggregator."""

    def __init__(self, stale_timeout_sec: float = 5.0, max_entities: int = 64) -> None:
        self._stale_timeout = stale_timeout_sec
        self._max_entities = max_entities
        self._entities: dict[str, _InternalEntity] = {}
        # Entity slots from perception pipeline (updated by pipeline callback)
        self._entity_slots: tuple[float, ...] = (0.0,) * TOTAL_ENTITY_DIMS
        # Latest robot proprioception (updated by telemetry feed)
        self._battery_mv: int = 12000
        self._imu_roll: float = 0.0
        self._imu_pitch: float = 0.0
        self._is_walking: bool = False
        self._walk_x: float = 0.0
        self._walk_y: float = 0.0
        self._walk_yaw: float = 0.0
        self._walk_height: float = 0.036
        self._walk_speed: int = 2
        self._head_pan: float = 0.0
        self._head_tilt: float = 0.0

    # ------------------------------------------------------------------
    # Entity feeds
    # ------------------------------------------------------------------

    def update_entity(
        self,
        entity_id: str,
        label: str,
        confidence: float,
        x: float = 0.0,
        y: float = 0.0,
        z: float = 0.0,
        source: str = "object",
    ) -> None:
        """Add or update a tracked entity."""
        now = time.monotonic()
        self._entities[entity_id] = _InternalEntity(
            entity_id=entity_id,
            label=label,
            confidence=confidence,
            x=x, y=y, z=z,
            last_seen=now,
            source=source,
        )
        self._prune()

    def remove_entity(self, entity_id: str) -> None:
        self._entities.pop(entity_id, None)

    def update_entities_batch(self, entities: list[dict[str, Any]]) -> None:
        """Batch update from a detection frame."""
        now = time.monotonic()
        for e in entities:
            eid = str(e.get("entity_id", e.get("id", "")))
            if not eid:
                continue
            self._entities[eid] = _InternalEntity(
                entity_id=eid,
                label=str(e.get("label", "unknown")),
                confidence=float(e.get("confidence", 0.0)),
                x=float(e.get("x", 0.0)),
                y=float(e.get("y", 0.0)),
                z=float(e.get("z", 0.0)),
                last_seen=now,
                source=str(e.get("source", "object")),
            )
        self._prune()

    # ------------------------------------------------------------------
    # Telemetry feed (from bridge events)
    # ------------------------------------------------------------------

    def update_entity_slots(self, slots: tuple[float, ...]) -> None:
        """Update entity slots from perception pipeline."""
        self._entity_slots = canonical_entity_slots(slots)

    def update_telemetry(self, data: dict[str, Any]) -> None:
        """Update robot proprioception from bridge telemetry event data."""
        if "battery_mv" in data:
            self._battery_mv = int(data["battery_mv"])
        if "imu_roll" in data:
            self._imu_roll = float(data["imu_roll"])
        if "imu_pitch" in data:
            self._imu_pitch = float(data["imu_pitch"])
        if "is_walking" in data:
            self._is_walking = bool(data["is_walking"])
        if "walk_x" in data:
            self._walk_x = float(data["walk_x"])
        if "walk_y" in data:
            self._walk_y = float(data["walk_y"])
        if "walk_yaw" in data:
            self._walk_yaw = float(data["walk_yaw"])
        if "walk_height" in data:
            self._walk_height = float(data["walk_height"])
        if "walk_speed" in data:
            self._walk_speed = int(data["walk_speed"])
        if "head_pan" in data:
            self._head_pan = float(data["head_pan"])
        if "head_tilt" in data:
            self._head_tilt = float(data["head_tilt"])

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def snapshot(
        self,
        language_instruction: str = "",
        camera_frame: str = "",
    ) -> AinexPerceptionObservation:
        """Return a frozen snapshot of the current perception state."""
        now = time.monotonic()
        self._prune()

        tracked = tuple(
            TrackedEntity(
                entity_id=e.entity_id,
                label=e.label,
                confidence=e.confidence,
                x=e.x,
                y=e.y,
                z=e.z,
                last_seen=e.last_seen,
            )
            for e in sorted(
                self._entities.values(),
                key=lambda e: e.confidence,
                reverse=True,
            )
        )

        return AinexPerceptionObservation(
            timestamp=now,
            battery_mv=self._battery_mv,
            imu_roll=self._imu_roll,
            imu_pitch=self._imu_pitch,
            is_walking=self._is_walking,
            walk_x=self._walk_x,
            walk_y=self._walk_y,
            walk_yaw=self._walk_yaw,
            walk_height=self._walk_height,
            walk_speed=self._walk_speed,
            head_pan=self._head_pan,
            head_tilt=self._head_tilt,
            tracked_entities=tracked,
            entity_slots=self._entity_slots,
            camera_frame=camera_frame,
            language_instruction=language_instruction,
            schema_version=AINEX_SCHEMA_VERSION,
        )

    def scene_summary(self) -> dict[str, Any]:
        """Return a JSON-serializable summary of the scene for providers."""
        self._prune()
        entities = []
        for e in sorted(
            self._entities.values(),
            key=lambda e: e.confidence,
            reverse=True,
        ):
            entities.append({
                "id": e.entity_id,
                "label": e.label,
                "confidence": round(e.confidence, 3),
                "position": [round(e.x, 3), round(e.y, 3), round(e.z, 3)],
                "source": e.source,
                "age_sec": round(time.monotonic() - e.last_seen, 2),
            })

        return {
            "schema_version": AINEX_SCHEMA_VERSION,
            "entity_count": len(entities),
            "entities": entities,
            "robot": {
                "battery_mv": self._battery_mv,
                "is_walking": self._is_walking,
                "imu_roll": round(self._imu_roll, 4),
                "imu_pitch": round(self._imu_pitch, 4),
                "walk": {
                    "x": self._walk_x,
                    "y": self._walk_y,
                    "yaw": self._walk_yaw,
                    "height": self._walk_height,
                    "speed": self._walk_speed,
                },
                "head": {
                    "pan": round(self._head_pan, 4),
                    "tilt": round(self._head_tilt, 4),
                },
            },
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _prune(self) -> None:
        """Remove stale entities and enforce max count."""
        now = time.monotonic()
        stale_ids = [
            eid for eid, e in self._entities.items()
            if (now - e.last_seen) > self._stale_timeout
        ]
        for eid in stale_ids:
            del self._entities[eid]

        # Enforce max by dropping lowest confidence
        if len(self._entities) > self._max_entities:
            sorted_entities = sorted(
                self._entities.items(),
                key=lambda kv: kv[1].confidence,
            )
            to_remove = len(self._entities) - self._max_entities
            for eid, _ in sorted_entities[:to_remove]:
                del self._entities[eid]
