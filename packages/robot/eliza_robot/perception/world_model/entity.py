"""Persistent entity representation for the world model.

Entities are 3D objects tracked across frames with position, velocity,
size, type, and identity information.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import IntEnum

import numpy as np

from eliza_robot.perception.entity_slots.slot_config import EntityType


@dataclass
class PersistentEntity:
    """A persistent tracked entity in the world model."""
    entity_id: str
    entity_type: EntityType = EntityType.UNKNOWN
    # 3D position in robot frame (meters)
    position: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    # 3D velocity in robot frame (m/s)
    velocity: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    # Size (width, height, depth) in meters
    size: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    # Detection confidence [0, 1]
    confidence: float = 0.0
    # Last seen timestamp (monotonic)
    last_seen: float = 0.0
    # Label from detector (e.g., "person", "chair", "cup")
    label: str = ""
    # Face identity (for persons)
    identity_id: str = ""
    # Face embedding (for persons, 512-d)
    face_embedding: np.ndarray | None = None
    # 2D bbox in image space (for association)
    bbox: np.ndarray | None = None
    # Number of frames this entity has been observed
    frames_seen: int = 0
    # Source detector ("face", "object", "skeleton", "slam", "aruco")
    source: str = ""
    # ArUco marker ID (if entity tracked via marker; -1 means not marker-based)
    marker_id: int = -1

    def update_position(self, new_pos: np.ndarray, dt: float) -> None:
        """Update position and estimate velocity."""
        if dt > 0 and self.frames_seen > 0:
            self.velocity = (new_pos - self.position) / dt
        self.position = new_pos.astype(np.float32)
        self.last_seen = time.monotonic()
        self.frames_seen += 1

    @property
    def age_sec(self) -> float:
        """Seconds since last seen."""
        return time.monotonic() - self.last_seen if self.last_seen > 0 else float("inf")

    @property
    def bearing_rad(self) -> float:
        """Bearing angle from robot to entity (radians, in x-y plane)."""
        return float(np.arctan2(self.position[1], self.position[0]))

    @property
    def distance(self) -> float:
        """Distance from robot to entity (meters)."""
        return float(np.linalg.norm(self.position))


def classify_entity_type(label: str) -> EntityType:
    """Map a detection label to an EntityType."""
    label_lower = label.lower()
    if label_lower == "person":
        return EntityType.PERSON
    if label_lower in {"chair", "couch", "bed", "dining table", "toilet", "bench", "desk"}:
        return EntityType.FURNITURE
    if label_lower in {"door"}:
        return EntityType.DOOR
    if label_lower in {"wall", "floor", "ceiling", "pillar", "column"}:
        return EntityType.LANDMARK
    if label_lower == "unknown":
        return EntityType.UNKNOWN
    return EntityType.OBJECT
