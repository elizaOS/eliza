"""World state: merges all detector outputs into persistent 3D entities.

Handles coordinate transforms, face-skeleton association, velocity
estimation, and stale entity pruning.
"""

from __future__ import annotations

import math
import time

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.depth_estimator import DepthResult
from eliza_robot.perception.detectors.face_tracker import FaceTrack
from eliza_robot.perception.detectors.object_detector import ObjectDetection
from eliza_robot.perception.detectors.object_tracker import TrackedObject
from eliza_robot.perception.detectors.skeleton_estimator import Skeleton
from eliza_robot.perception.detectors.utils import bbox_iou
from eliza_robot.perception.world_model.entity import (
    EntityType,
    PersistentEntity,
    classify_entity_type,
)


class WorldState:
    """Persistent 3D world model merging all detector outputs.

    Maintains a dictionary of PersistentEntity instances, updated
    each frame from face tracks, object detections, skeletons, and depth.
    """

    def __init__(
        self,
        intrinsics: CameraIntrinsics | None = None,
        stale_timeout_sec: float = 5.0,
        max_entities: int = 64,
    ) -> None:
        self._intrinsics = intrinsics or CameraIntrinsics()
        self._stale_timeout = stale_timeout_sec
        self._max_entities = max_entities
        self._entities: dict[str, PersistentEntity] = {}
        # Camera-to-robot transform (head pose)
        # Camera frame: X-right, Y-down, Z-forward
        # Robot frame:  X-forward, Y-left, Z-up
        # Base conversion (no pan/tilt):
        #   robot_X = cam_Z (forward)
        #   robot_Y = -cam_X (left = -right)
        #   robot_Z = -cam_Y (up = -down)
        self._cam_to_robot_base = np.array([
            [0, 0, 1],    # robot X = cam Z
            [-1, 0, 0],   # robot Y = -cam X
            [0, -1, 0],   # robot Z = -cam Y
        ], dtype=np.float32)
        self.set_head_pose(0.0, 0.0)

    def set_head_pose(self, pan: float, tilt: float) -> None:
        """Update camera-to-robot transform based on head pan/tilt.

        Pan rotates around robot Z (yaw), tilt rotates around robot Y (pitch).
        The transform chain is: cam_point -> base_rotation -> tilt -> pan -> translate.

        Convention: positive tilt = look up, negative tilt = look down.
        The AiNex servo uses the same convention, so we negate tilt to match
        the standard rotation matrix (positive angle around Y = X toward Z = up).
        """
        cp, sp = math.cos(pan), math.sin(pan)
        ct, st = math.cos(-tilt), math.sin(-tilt)
        # Pan (yaw around Z in robot frame)
        R_pan = np.array([
            [cp, -sp, 0],
            [sp, cp, 0],
            [0, 0, 1],
        ], dtype=np.float32)
        # Tilt (pitch around Y in robot frame)
        R_tilt = np.array([
            [ct, 0, st],
            [0, 1, 0],
            [-st, 0, ct],
        ], dtype=np.float32)
        # Full rotation: pan * tilt * base_conversion
        R = R_pan @ R_tilt @ self._cam_to_robot_base
        # Head camera offset in robot frame (x=0.03m forward, z=0.30m up)
        t = np.array([0.03, 0.0, 0.30], dtype=np.float32)
        self._cam_to_robot = np.eye(4, dtype=np.float32)
        self._cam_to_robot[:3, :3] = R
        self._cam_to_robot[:3, 3] = t

    def camera_to_robot(self, cam_point: np.ndarray) -> np.ndarray:
        """Transform a 3D point from camera frame to robot frame."""
        p = np.append(cam_point, 1.0)
        return (self._cam_to_robot @ p)[:3]

    def update_from_faces(
        self,
        face_tracks: list[FaceTrack],
        depth: DepthResult | None = None,
    ) -> None:
        """Update entities from face tracking results."""
        now = time.monotonic()
        for track in face_tracks:
            eid = f"person_{track.identity_id}"
            # Estimate 3D position from bbox center + depth
            cx = (track.bbox[0] + track.bbox[2]) / 2
            cy = (track.bbox[1] + track.bbox[3]) / 2
            if depth is not None:
                d = depth.roi_depth(track.bbox)
            else:
                # Estimate from face size (typical face ~0.18m wide)
                face_w = track.bbox[2] - track.bbox[0]
                d = 0.18 * self._intrinsics.fx / max(face_w, 1.0)

            cam_pos = self._intrinsics.pixel_to_3d(float(cx), float(cy), d)
            robot_pos = self.camera_to_robot(cam_pos)

            entity = self._entities.get(eid)
            if entity is None:
                entity = PersistentEntity(
                    entity_id=eid,
                    entity_type=EntityType.PERSON,
                    label="person",
                    source="face",
                )
                self._entities[eid] = entity

            # Per-entity dt from its own last_seen timestamp
            entity_dt = now - entity.last_seen if entity.last_seen > 0 else 0.033
            entity.update_position(robot_pos, entity_dt)
            entity.confidence = track.confidence
            entity.identity_id = track.identity_id
            entity.bbox = track.bbox.copy()
            if track.embedding is not None:
                entity.face_embedding = track.embedding.copy()
            # Estimate person size from bbox
            h_pixels = track.bbox[3] - track.bbox[1]
            w_pixels = track.bbox[2] - track.bbox[0]
            entity.size = np.array([
                w_pixels / self._intrinsics.fx * d,
                h_pixels / self._intrinsics.fy * d,
                0.3,  # estimated depth
            ], dtype=np.float32)

    def update_from_objects(
        self,
        objects: list[TrackedObject] | list[ObjectDetection],
        depth: DepthResult | None = None,
    ) -> None:
        """Update entities from object detection/tracking results."""
        now = time.monotonic()
        for obj in objects:
            if isinstance(obj, TrackedObject):
                eid = f"obj_{obj.class_name}_{obj.track_id}"
            else:
                eid = f"obj_{obj.class_name}_{id(obj)}"

            cx = (obj.bbox[0] + obj.bbox[2]) / 2
            cy = (obj.bbox[1] + obj.bbox[3]) / 2
            if depth is not None:
                d = depth.roi_depth(obj.bbox)
            else:
                d = 2.0  # default 2m

            cam_pos = self._intrinsics.pixel_to_3d(float(cx), float(cy), d)
            robot_pos = self.camera_to_robot(cam_pos)

            entity = self._entities.get(eid)
            if entity is None:
                entity = PersistentEntity(
                    entity_id=eid,
                    entity_type=classify_entity_type(obj.class_name),
                    label=obj.class_name,
                    source="object",
                )
                self._entities[eid] = entity

            entity_dt = now - entity.last_seen if entity.last_seen > 0 else 0.033
            entity.update_position(robot_pos, entity_dt)
            entity.confidence = obj.confidence
            entity.bbox = obj.bbox.copy()
            # Size from bbox
            h_pixels = obj.bbox[3] - obj.bbox[1]
            w_pixels = obj.bbox[2] - obj.bbox[0]
            entity.size = np.array([
                w_pixels / self._intrinsics.fx * d,
                h_pixels / self._intrinsics.fy * d,
                0.3,
            ], dtype=np.float32)

    def update_from_skeletons(
        self,
        skeletons: list[Skeleton],
        depth: DepthResult | None = None,
    ) -> None:
        """Associate skeletons with existing person entities (by bbox IoU)."""
        for skel in skeletons:
            # Find best matching person entity
            best_eid = ""
            best_iou = 0.3  # minimum IoU
            for eid, entity in self._entities.items():
                if entity.entity_type != EntityType.PERSON:
                    continue
                if entity.bbox is None:
                    continue
                iou = bbox_iou(skel.bbox, entity.bbox)
                if iou > best_iou:
                    best_iou = iou
                    best_eid = eid

            if best_eid:
                entity = self._entities[best_eid]
                # Refine position using torso center (no velocity update —
                # this is a same-frame refinement, not a temporal update)
                tc = skel.get_torso_center()
                if tc is not None and depth is not None:
                    d = depth.depth_at(int(tc[0]), int(tc[1]))
                    cam_pos = self._intrinsics.pixel_to_3d(float(tc[0]), float(tc[1]), d)
                    robot_pos = self.camera_to_robot(cam_pos)
                    # Directly set position without velocity update
                    entity.position = robot_pos.astype(np.float32)
                    entity.last_seen = time.monotonic()
                    # Better height estimate from skeleton
                    entity.size[1] = skel.height_pixels / self._intrinsics.fy * d

    def update_from_aruco(
        self,
        detections: list,  # list[ArucoDetection]
        object_markers: dict[int, str],
        robot_marker_ids: list[int] | None = None,
        robot_head_marker_id: int = -1,
    ) -> None:
        """Update entities from ArUco marker detections.

        Parameters
        ----------
        detections : list[ArucoDetection]
            ArUco detections from the ego camera with 6-DOF poses.
        object_markers : dict[int, str]
            Mapping of marker_id -> object label (e.g. {6: "red_ball"}).
        robot_marker_ids : list[int], optional
            Marker IDs on the robot body (skip these).
        robot_head_marker_id : int, optional
            Head marker ID (skip).
        """
        now = time.monotonic()
        skip_ids = set(robot_marker_ids or [])
        if robot_head_marker_id >= 0:
            skip_ids.add(robot_head_marker_id)

        for det in detections:
            mid = det.marker_id
            if mid in skip_ids:
                continue
            if mid not in object_markers:
                continue

            label = object_markers[mid]
            eid = f"aruco_{mid}_{label}"

            # Transform from camera frame to robot frame
            cam_pos = det.tvec.astype(np.float32)
            robot_pos = self.camera_to_robot(cam_pos)

            entity = self._entities.get(eid)
            if entity is None:
                entity = PersistentEntity(
                    entity_id=eid,
                    entity_type=EntityType.OBJECT,
                    label=label,
                    source="aruco",
                    marker_id=mid,
                )
                self._entities[eid] = entity

            entity_dt = now - entity.last_seen if entity.last_seen > 0 else 0.033
            entity.update_position(robot_pos, entity_dt)
            entity.confidence = det.confidence
            entity.size = np.array([0.05, 0.05, 0.05], dtype=np.float32)

    def prune_stale(self) -> int:
        """Remove entities not seen within stale_timeout. Returns count removed."""
        now = time.monotonic()
        stale = [eid for eid, e in self._entities.items()
                 if (now - e.last_seen) > self._stale_timeout]
        for eid in stale:
            del self._entities[eid]

        # Enforce max count (drop lowest confidence)
        if len(self._entities) > self._max_entities:
            by_conf = sorted(self._entities.items(), key=lambda kv: kv[1].confidence)
            to_remove = len(self._entities) - self._max_entities
            for eid, _ in by_conf[:to_remove]:
                del self._entities[eid]
            return len(stale) + to_remove

        return len(stale)

    def add_or_update_entity(self, entity_id: str, entity: PersistentEntity) -> None:
        """Add or update an entity by ID (for external sources like ArUco)."""
        self._entities[entity_id] = entity

    @property
    def entities(self) -> dict[str, PersistentEntity]:
        return self._entities

    @property
    def entity_list(self) -> list[PersistentEntity]:
        return list(self._entities.values())

    @property
    def person_count(self) -> int:
        return sum(1 for e in self._entities.values() if e.entity_type == EntityType.PERSON)

    @property
    def object_count(self) -> int:
        return sum(1 for e in self._entities.values() if e.entity_type != EntityType.PERSON)

