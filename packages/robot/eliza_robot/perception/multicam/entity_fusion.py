"""Multi-camera entity fusion in world frame.

Merges entity observations from the robot's ego camera and an external
room camera into a unified world-frame entity set. Uses ArUco markers
on the robot to track its world pose, and Hungarian assignment for
cross-view data association.
"""

from __future__ import annotations

import logging
import math
import time

import numpy as np

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    cv2 = None  # type: ignore[assignment]
    _HAS_CV2 = False

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetection
from eliza_robot.perception.detectors.object_detector import ObjectDetection
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
    TYPE_OFFSET,
    VELOCITY_OFFSET,
    EntityType,
)
from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics
from eliza_robot.perception.world_model.entity import PersistentEntity, classify_entity_type

logger = logging.getLogger(__name__)

# Default association threshold (meters) for matching entities across views
_DEFAULT_ASSOCIATION_THRESHOLD = 1.0


def _linear_sum_assignment(cost_matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Minimal Hungarian algorithm implementation for entity association.

    Uses scipy if available, otherwise falls back to a greedy assignment.

    Parameters
    ----------
    cost_matrix : np.ndarray
        (N, M) cost matrix.

    Returns
    -------
    tuple[np.ndarray, np.ndarray]
        Row and column indices of the optimal assignment.
    """
    try:
        from scipy.optimize import linear_sum_assignment

        return linear_sum_assignment(cost_matrix)
    except ImportError:
        pass

    # Greedy fallback: assign cheapest first
    n, m = cost_matrix.shape
    row_inds = []
    col_inds = []
    used_rows: set[int] = set()
    used_cols: set[int] = set()

    # Flatten and sort all (row, col) pairs by cost
    flat = cost_matrix.ravel()
    order = np.argsort(flat)

    for idx in order:
        r = int(idx // m)
        c = int(idx % m)
        if r in used_rows or c in used_cols:
            continue
        row_inds.append(r)
        col_inds.append(c)
        used_rows.add(r)
        used_cols.add(c)
        if len(row_inds) >= min(n, m):
            break

    return np.array(row_inds, dtype=int), np.array(col_inds, dtype=int)


class FusedWorldState:
    """Multi-camera entity fusion in world frame.

    Extends single-camera WorldState with:
    - World-frame entity positions (not just robot-frame)
    - Multi-camera data association
    - Robot pose from external camera ArUco markers
    - Confidence weighting by camera source

    Coordinate frames:
    - World frame: fixed reference (defined by ArUco marker positions)
    - Robot frame: robot-centric (X-forward, Y-left, Z-up)
    - Camera frame: camera-centric (X-right, Y-down, Z-forward)
    """

    def __init__(
        self,
        ego_intrinsics: CameraIntrinsics,
        external_intrinsics: CameraIntrinsics | None = None,
        external_extrinsics: CameraExtrinsics | None = None,
        robot_marker_ids: list[int] | None = None,
        world_marker_ids: list[int] | None = None,
        association_threshold: float = _DEFAULT_ASSOCIATION_THRESHOLD,
        stale_timeout_sec: float = 5.0,
        max_entities: int = 64,
    ) -> None:
        """
        Parameters
        ----------
        ego_intrinsics : CameraIntrinsics
            Intrinsics for the robot head camera.
        external_intrinsics : CameraIntrinsics, optional
            Intrinsics for the external room camera.
        external_extrinsics : CameraExtrinsics, optional
            Extrinsics for the external camera (camera -> world).
        robot_marker_ids : list[int], optional
            ArUco marker IDs attached to the robot (for external pose estimation).
        world_marker_ids : list[int], optional
            ArUco marker IDs fixed in the world (for calibration reference).
        association_threshold : float
            Maximum distance (meters) for matching entities across cameras.
        stale_timeout_sec : float
            Seconds after which unseen entities are pruned.
        max_entities : int
            Maximum number of tracked entities.
        """
        self._ego_intrinsics = ego_intrinsics
        self._external_intrinsics = external_intrinsics
        self._external_extrinsics = external_extrinsics
        self._robot_marker_ids = set(robot_marker_ids or [])
        self._world_marker_ids = set(world_marker_ids or [])
        self._assoc_threshold = association_threshold
        self._stale_timeout = stale_timeout_sec
        self._max_entities = max_entities

        # Ego camera entity observations (world frame)
        self._ego_entities: dict[str, PersistentEntity] = {}
        # External camera entity observations (world frame)
        self._ext_entities: dict[str, PersistentEntity] = {}
        # Fused entities (world frame)
        self._fused_entities: dict[str, PersistentEntity] = {}

        # Robot pose in world frame (4x4 homogeneous transform)
        self._robot_world_pose: np.ndarray | None = None
        self._robot_pose_timestamp: float = 0.0

        # Camera-to-robot base rotation (same as WorldState)
        self._cam_to_robot_base = np.array(
            [
                [0, 0, 1],  # robot X = cam Z
                [-1, 0, 0],  # robot Y = -cam X
                [0, -1, 0],  # robot Z = -cam Y
            ],
            dtype=np.float64,
        )

    # ------------------------------------------------------------------
    # Robot pose estimation
    # ------------------------------------------------------------------

    @property
    def robot_world_pose(self) -> np.ndarray | None:
        """Current robot pose in world frame (4x4) if available."""
        return self._robot_world_pose

    @property
    def robot_world_position(self) -> np.ndarray | None:
        """Robot position in world frame (3,), or None."""
        if self._robot_world_pose is None:
            return None
        return self._robot_world_pose[:3, 3].copy()

    def update_robot_pose_from_external(
        self,
        aruco_detections: list[ArucoDetection],
    ) -> np.ndarray | None:
        """Estimate robot pose in world frame from external camera ArUco detections.

        Looks for markers in robot_marker_ids among the detections from the
        external camera. Uses the known external camera extrinsics to map
        marker positions into world frame, then estimates the robot body
        pose from the marker arrangement.

        Parameters
        ----------
        aruco_detections : list[ArucoDetection]
            ArUco detections from the external camera.

        Returns
        -------
        np.ndarray or None
            4x4 world-from-robot transform, or None if not enough markers.
        """
        if self._external_extrinsics is None:
            logger.debug("No external extrinsics, cannot estimate robot pose")
            return None

        if not self._robot_marker_ids:
            logger.debug("No robot marker IDs configured")
            return None

        # Find robot markers among detections
        robot_detections = [
            d for d in aruco_detections if d.marker_id in self._robot_marker_ids
        ]
        if not robot_detections:
            return None

        # Transform each detected robot marker's position to world frame
        ext = self._external_extrinsics
        world_positions = []
        for det in robot_detections:
            # det.tvec is marker position in camera frame
            world_pos = ext.transform_point(det.tvec)
            world_positions.append(world_pos)

        # Estimate robot position as centroid of marker positions
        robot_pos_world = np.mean(world_positions, axis=0)

        # For orientation: if we have the marker rotation, we can estimate
        # robot heading. Use the first marker's rotation as approximation.
        det0 = robot_detections[0]
        if not _HAS_CV2:
            return None

        R_marker_to_cam, _ = cv2.Rodrigues(det0.rvec)
        # Marker-to-world rotation
        R_marker_to_world = ext.R @ R_marker_to_cam

        # The robot's forward direction (X-axis in robot frame) can be estimated
        # from the marker's normal (Z-axis in marker frame)
        # This is an approximation; with multiple markers we could do better
        marker_z_world = R_marker_to_world[:, 2]
        # Project onto XY plane for heading
        heading = math.atan2(marker_z_world[1], marker_z_world[0])

        # Build robot-to-world transform
        ch, sh = math.cos(heading), math.sin(heading)
        R_robot_to_world = np.array(
            [
                [ch, -sh, 0],
                [sh, ch, 0],
                [0, 0, 1],
            ],
            dtype=np.float64,
        )

        T_robot_to_world = np.eye(4, dtype=np.float64)
        T_robot_to_world[:3, :3] = R_robot_to_world
        T_robot_to_world[:3, 3] = robot_pos_world

        self._robot_world_pose = T_robot_to_world
        self._robot_pose_timestamp = time.monotonic()

        return T_robot_to_world

    # ------------------------------------------------------------------
    # Entity updates
    # ------------------------------------------------------------------

    def update_from_ego(
        self,
        entities: list[PersistentEntity],
        robot_head_pose: tuple[float, float],
    ) -> None:
        """Update entities from robot camera (transforms to world frame).

        Parameters
        ----------
        entities : list[PersistentEntity]
            Entities detected by the ego camera, in robot frame.
        robot_head_pose : tuple[float, float]
            (pan, tilt) of the robot head in radians.
        """
        now = time.monotonic()
        for entity in entities:
            eid = f"ego_{entity.entity_id}"

            # Entity positions from WorldState are already in robot frame.
            # If we have a robot-to-world pose, transform to world frame.
            pos_robot = entity.position.astype(np.float64)
            if self._robot_world_pose is not None:
                pos_h = np.append(pos_robot, 1.0)
                pos_world = (self._robot_world_pose @ pos_h)[:3]
            else:
                pos_world = pos_robot

            if eid in self._ego_entities:
                existing = self._ego_entities[eid]
                dt = now - existing.last_seen if existing.last_seen > 0 else 0.033
                existing.update_position(pos_world.astype(np.float32), dt)
                existing.confidence = entity.confidence
                existing.size = entity.size.copy()
            else:
                new_entity = PersistentEntity(
                    entity_id=eid,
                    entity_type=entity.entity_type,
                    position=pos_world.astype(np.float32),
                    velocity=entity.velocity.copy(),
                    size=entity.size.copy(),
                    confidence=entity.confidence,
                    last_seen=now,
                    label=entity.label,
                    identity_id=entity.identity_id,
                    source="ego",
                )
                self._ego_entities[eid] = new_entity

    def update_from_external(
        self,
        detections: list[ObjectDetection],
        depth: np.ndarray | None = None,
    ) -> None:
        """Update entities from external camera detections.

        Parameters
        ----------
        detections : list[ObjectDetection]
            Object detections from the external camera.
        depth : np.ndarray, optional
            Depth map from the external camera (H, W) in meters.
        """
        if self._external_intrinsics is None or self._external_extrinsics is None:
            return

        now = time.monotonic()
        ext_intr = self._external_intrinsics
        ext_ext = self._external_extrinsics

        for i, det in enumerate(detections):
            eid = f"ext_{det.class_name}_{i}"

            cx = (det.bbox[0] + det.bbox[2]) / 2.0
            cy = (det.bbox[1] + det.bbox[3]) / 2.0

            # Estimate depth
            if depth is not None:
                ix, iy = int(np.clip(cx, 0, depth.shape[1] - 1)), int(
                    np.clip(cy, 0, depth.shape[0] - 1)
                )
                d = float(depth[iy, ix])
                if d <= 0:
                    d = 2.0
            else:
                d = 2.0  # default depth

            # Back-project to 3D in camera frame
            cam_point = ext_intr.pixel_to_3d(float(cx), float(cy), d)

            # Transform to world frame
            world_point = ext_ext.transform_point(cam_point)

            # Estimate size from bbox
            w_pixels = det.bbox[2] - det.bbox[0]
            h_pixels = det.bbox[3] - det.bbox[1]
            size = np.array(
                [
                    w_pixels / ext_intr.fx * d,
                    h_pixels / ext_intr.fy * d,
                    0.3,
                ],
                dtype=np.float32,
            )

            entity_type = classify_entity_type(det.class_name)

            if eid in self._ext_entities:
                existing = self._ext_entities[eid]
                dt = now - existing.last_seen if existing.last_seen > 0 else 0.033
                existing.update_position(world_point.astype(np.float32), dt)
                existing.confidence = det.confidence
                existing.size = size
            else:
                new_entity = PersistentEntity(
                    entity_id=eid,
                    entity_type=entity_type,
                    position=world_point.astype(np.float32),
                    velocity=np.zeros(3, dtype=np.float32),
                    size=size,
                    confidence=det.confidence,
                    last_seen=now,
                    label=det.class_name,
                    source="external",
                )
                self._ext_entities[eid] = new_entity

    # ------------------------------------------------------------------
    # Fusion
    # ------------------------------------------------------------------

    def fuse(self) -> list[PersistentEntity]:
        """Fuse entity observations from all cameras.

        Uses Hungarian algorithm for data association across views,
        then weighted averaging for position estimation.

        Returns
        -------
        list[PersistentEntity]
            Fused entities in world frame.
        """
        now = time.monotonic()

        # Prune stale from both sources
        self._prune_stale(self._ego_entities, now)
        self._prune_stale(self._ext_entities, now)

        ego_list = list(self._ego_entities.values())
        ext_list = list(self._ext_entities.values())

        if not ego_list and not ext_list:
            self._fused_entities.clear()
            return []

        if not ext_list:
            # Only ego entities — enforce max_entities limit
            sorted_ego = sorted(ego_list, key=lambda e: e.confidence, reverse=True)
            limited = sorted_ego[: self._max_entities]
            self._fused_entities = {e.entity_id: e for e in limited}
            return limited

        if not ego_list:
            # Only external entities — enforce max_entities limit
            sorted_ext = sorted(ext_list, key=lambda e: e.confidence, reverse=True)
            limited = sorted_ext[: self._max_entities]
            self._fused_entities = {e.entity_id: e for e in limited}
            return limited

        # Build cost matrix based on 3D position distance
        n_ego = len(ego_list)
        n_ext = len(ext_list)
        cost = np.full((n_ego, n_ext), fill_value=1e6, dtype=np.float64)

        for i, ego_e in enumerate(ego_list):
            for j, ext_e in enumerate(ext_list):
                # Only match entities of compatible types
                if ego_e.entity_type != ext_e.entity_type:
                    continue
                dist = float(np.linalg.norm(ego_e.position - ext_e.position))
                cost[i, j] = dist

        # Run assignment
        row_inds, col_inds = _linear_sum_assignment(cost)

        matched_ego: set[int] = set()
        matched_ext: set[int] = set()
        fused: dict[str, PersistentEntity] = {}

        for ri, ci in zip(row_inds, col_inds):
            if cost[ri, ci] > self._assoc_threshold:
                continue  # reject distant matches

            ego_e = ego_list[ri]
            ext_e = ext_list[ci]
            matched_ego.add(ri)
            matched_ext.add(ci)

            # Weighted average by confidence
            w_ego = ego_e.confidence
            w_ext = ext_e.confidence
            w_total = w_ego + w_ext
            if w_total < 1e-8:
                w_ego = w_ext = 0.5
                w_total = 1.0

            fused_pos = (
                ego_e.position * w_ego + ext_e.position * w_ext
            ) / w_total
            fused_vel = (
                ego_e.velocity * w_ego + ext_e.velocity * w_ext
            ) / w_total
            fused_size = (
                ego_e.size * w_ego + ext_e.size * w_ext
            ) / w_total
            fused_conf = max(ego_e.confidence, ext_e.confidence)

            fused_id = f"fused_{ego_e.entity_id}"
            fused_entity = PersistentEntity(
                entity_id=fused_id,
                entity_type=ego_e.entity_type,
                position=fused_pos.astype(np.float32),
                velocity=fused_vel.astype(np.float32),
                size=fused_size.astype(np.float32),
                confidence=fused_conf,
                last_seen=max(ego_e.last_seen, ext_e.last_seen),
                label=ego_e.label or ext_e.label,
                identity_id=ego_e.identity_id,
                source="fused",
                frames_seen=ego_e.frames_seen + ext_e.frames_seen,
            )
            fused[fused_id] = fused_entity

        # Add unmatched ego entities
        for i, ego_e in enumerate(ego_list):
            if i not in matched_ego:
                fused[ego_e.entity_id] = ego_e

        # Add unmatched external entities
        for j, ext_e in enumerate(ext_list):
            if j not in matched_ext:
                fused[ext_e.entity_id] = ext_e

        # Enforce max entities (drop lowest confidence)
        if len(fused) > self._max_entities:
            by_conf = sorted(fused.items(), key=lambda kv: kv[1].confidence)
            to_remove = len(fused) - self._max_entities
            for eid, _ in by_conf[:to_remove]:
                del fused[eid]

        self._fused_entities = fused
        return list(fused.values())

    def get_entity_slots(self) -> np.ndarray:
        """Get fused entity slot vector (8 x 19 = 152 dims).

        Positions, distances, and bearings are computed relative to the
        robot's current world position (if known), falling back to the
        world origin otherwise.
        """
        entities = list(self._fused_entities.values())
        robot_pos = self.robot_world_position  # may be None

        def _dist_from_robot(e: PersistentEntity) -> float:
            if robot_pos is not None:
                return float(np.linalg.norm(e.position - robot_pos))
            return float(np.linalg.norm(e.position))

        persons = [e for e in entities if e.entity_type == EntityType.PERSON]
        others = [e for e in entities if e.entity_type != EntityType.PERSON]
        persons.sort(key=_dist_from_robot)
        others.sort(key=_dist_from_robot)
        sorted_entities = persons + others

        slots = np.zeros((NUM_ENTITY_SLOTS, SLOT_DIM), dtype=np.float32)
        for i, entity in enumerate(sorted_entities[:NUM_ENTITY_SLOTS]):
            slots[i] = self._encode_slot(entity, robot_pos)

        return slots.flatten()

    @staticmethod
    def _encode_slot(
        entity: PersistentEntity,
        robot_pos: np.ndarray | None = None,
    ) -> np.ndarray:
        """Encode a single entity into a (SLOT_DIM,) vector.

        If *robot_pos* is provided, position and bearing are encoded
        relative to the robot rather than to the world origin.
        """
        slot = np.zeros(SLOT_DIM, dtype=np.float32)

        # One-hot entity type
        type_idx = int(entity.entity_type)
        if 0 <= type_idx < NUM_ENTITY_TYPES:
            slot[TYPE_OFFSET + type_idx] = 1.0

        # Position relative to robot (or origin)
        if robot_pos is not None:
            rel_pos = entity.position - robot_pos.astype(np.float32)
        else:
            rel_pos = entity.position
        pos = np.clip(rel_pos / MAX_DISTANCE, -1.0, 1.0)
        slot[POSITION_OFFSET : POSITION_OFFSET + 3] = pos

        # Velocity xyz normalized to [-1, 1]
        vel = np.clip(entity.velocity / MAX_VELOCITY, -1.0, 1.0)
        slot[VELOCITY_OFFSET : VELOCITY_OFFSET + 3] = vel

        # Size whd normalized to [0, 1]
        sz = np.clip(entity.size / MAX_SIZE, 0.0, 1.0)
        slot[SIZE_OFFSET : SIZE_OFFSET + 3] = sz

        # Confidence [0, 1]
        slot[CONFIDENCE_OFFSET] = np.clip(entity.confidence, 0.0, 1.0)

        # Recency
        slot[RECENCY_OFFSET] = np.clip(
            entity.age_sec / RECENCY_HORIZON, 0.0, 1.0
        )

        # Bearing relative to robot (or origin)
        bearing = float(np.arctan2(rel_pos[1], rel_pos[0]))
        slot[BEARING_OFFSET] = np.sin(bearing)
        slot[BEARING_OFFSET + 1] = np.cos(bearing)

        return slot

    def snapshot(self) -> dict:
        """Export current fused state as an EmbodiedContext dict.

        Returns a dictionary compatible with the PerceptionAggregator
        scene_summary format, extended with world-frame information.
        """
        entities_out = []
        for e in sorted(
            self._fused_entities.values(),
            key=lambda e: e.confidence,
            reverse=True,
        ):
            entities_out.append(
                {
                    "id": e.entity_id,
                    "label": e.label,
                    "type": e.entity_type.name,
                    "confidence": round(e.confidence, 3),
                    "position_world": [
                        round(float(e.position[0]), 3),
                        round(float(e.position[1]), 3),
                        round(float(e.position[2]), 3),
                    ],
                    "velocity": [
                        round(float(e.velocity[0]), 3),
                        round(float(e.velocity[1]), 3),
                        round(float(e.velocity[2]), 3),
                    ],
                    "source": e.source,
                    "age_sec": round(e.age_sec, 2),
                }
            )

        robot_pose_out = None
        if self._robot_world_pose is not None:
            robot_pose_out = {
                "position": self._robot_world_pose[:3, 3].tolist(),
                "rotation_3x3": self._robot_world_pose[:3, :3].tolist(),
                "timestamp": self._robot_pose_timestamp,
            }

        return {
            "frame": "world",
            "entity_count": len(entities_out),
            "entities": entities_out,
            "robot_world_pose": robot_pose_out,
            "entity_slots": self.get_entity_slots().tolist(),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _prune_stale(
        self, entities: dict[str, PersistentEntity], now: float
    ) -> None:
        """Remove entities not seen within stale_timeout."""
        stale = [
            eid
            for eid, e in entities.items()
            if (now - e.last_seen) > self._stale_timeout
        ]
        for eid in stale:
            del entities[eid]

    @property
    def ego_entities(self) -> dict[str, PersistentEntity]:
        return self._ego_entities

    @property
    def external_entities(self) -> dict[str, PersistentEntity]:
        return self._ext_entities

    @property
    def fused_entities(self) -> dict[str, PersistentEntity]:
        return self._fused_entities
