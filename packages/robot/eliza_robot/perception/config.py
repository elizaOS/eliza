"""Global perception configuration with YAML loading support."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from pathlib import Path

from eliza_robot.perception.calibration import CameraIntrinsics

_ROOT = Path(__file__).resolve().parent

# Derive camera defaults from the single source of truth
_DEFAULT_INTRINSICS = CameraIntrinsics()


@dataclass
class CameraConfig:
    """Camera parameters."""
    width: int = _DEFAULT_INTRINSICS.width
    height: int = _DEFAULT_INTRINSICS.height
    fps: int = 30
    device: int = 0
    fx: float = _DEFAULT_INTRINSICS.fx
    fy: float = _DEFAULT_INTRINSICS.fy
    cx: float = _DEFAULT_INTRINSICS.cx
    cy: float = _DEFAULT_INTRINSICS.cy
    dist_coeffs: tuple[float, ...] = _DEFAULT_INTRINSICS.dist_coeffs


@dataclass
class DetectorConfig:
    """Detector thresholds."""
    face_confidence: float = 0.5
    face_recognition_threshold: float = 0.4
    object_confidence: float = 0.5
    skeleton_confidence: float = 0.3
    depth_enabled: bool = True


@dataclass
class EntitySlotConfig:
    """Entity slot encoding parameters."""
    num_slots: int = 8
    slot_dim: int = 19
    max_distance: float = 5.0
    max_velocity: float = 2.0
    max_size: float = 2.0
    recency_horizon: float = 5.0


@dataclass
class ExternalCameraConfig:
    """External / room camera configuration."""
    enabled: bool = False
    device: int = 1  # second USB camera
    width: int = 1280
    height: int = 720
    fps: int = 30
    fx: float = 800.0
    fy: float = 800.0
    cx: float = 640.0
    cy: float = 360.0
    dist_coeffs: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0, 0.0)
    extrinsics_file: str = ""  # path to calibrated extrinsics YAML


@dataclass
class MarkerConfig:
    """ArUco marker configuration for multi-camera localization.

    Default marker assignment (DICT_6X6_250):
        ID 0  — robot body (back/chest)
        ID 1  — robot head (forehead, tracks head pose)
        ID 2  — ground corner: origin       (0, 0, 0)
        ID 3  — ground corner: +X           (1, 0, 0)
        ID 4  — ground corner: +X +Y        (1, 1, 0)
        ID 5  — ground corner: +Y           (0, 1, 0)
        ID 6  — object: "red_ball"
        ID 7  — object: "blue_cube"
        ID 8  — object: "green_cylinder"
    """
    dictionary: str = "DICT_6X6_250"
    marker_size_m: float = 0.0508  # 2 inches (matches printables/aruco)
    # Markers fixed in the world (ground plane): id → [x, y, z] meters
    world_markers: dict[int, list[float]] = field(default_factory=lambda: {
        2: [0.0, 0.0, 0.0],
        3: [1.0, 0.0, 0.0],
        4: [1.0, 1.0, 0.0],
        5: [0.0, 1.0, 0.0],
    })
    # Markers attached to the robot (for external pose estimation)
    robot_marker_ids: list[int] = field(default_factory=lambda: [0])
    # Marker on the robot head (tracks head pan/tilt independently)
    robot_head_marker_id: int = 1
    # Markers attached to movable objects: id → label
    object_markers: dict[int, str] = field(default_factory=lambda: {
        6: "red_ball",
        7: "blue_cube",
        8: "green_cylinder",
    })


@dataclass
class PipelineConfig:
    """Full pipeline configuration."""
    camera: CameraConfig = field(default_factory=CameraConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    entity_slots: EntitySlotConfig = field(default_factory=EntitySlotConfig)
    external_camera: ExternalCameraConfig = field(default_factory=ExternalCameraConfig)
    markers: MarkerConfig = field(default_factory=MarkerConfig)
    stale_timeout_sec: float = 5.0
    data_dir: Path = field(default_factory=lambda: _ROOT / "data")


def load_config(path: Path | None = None) -> PipelineConfig:
    """Load pipeline config from YAML file, falling back to defaults."""
    if path is None or not path.exists():
        return PipelineConfig()
    try:
        import yaml
        with open(path) as f:
            raw = yaml.safe_load(f) or {}
    except ImportError:
        return PipelineConfig()

    cfg = PipelineConfig()
    if "camera" in raw:
        cam = raw["camera"]
        cfg.camera = CameraConfig(
            width=cam.get("width", 640),
            height=cam.get("height", 480),
            fps=cam.get("fps", 30),
            device=cam.get("device", 0),
            fx=cam.get("fx", 533.0),
            fy=cam.get("fy", 533.0),
            cx=cam.get("cx", 320.0),
            cy=cam.get("cy", 240.0),
            dist_coeffs=tuple(cam.get("dist_coeffs", [0.0] * 5)),
        )
    if "detector" in raw:
        det = raw["detector"]
        valid_fields = {f.name for f in dataclasses.fields(DetectorConfig)}
        cfg.detector = DetectorConfig(**{
            k: det[k] for k in det if k in valid_fields
        })
    if "entity_slots" in raw:
        es = raw["entity_slots"]
        valid_fields = {f.name for f in dataclasses.fields(EntitySlotConfig)}
        cfg.entity_slots = EntitySlotConfig(**{
            k: es[k] for k in es if k in valid_fields
        })
    if "external_camera" in raw:
        ec = raw["external_camera"]
        valid_fields = {f.name for f in dataclasses.fields(ExternalCameraConfig)}
        cfg.external_camera = ExternalCameraConfig(**{
            k: ec[k] for k in ec if k in valid_fields
        })
    if "markers" in raw:
        mk = raw["markers"]
        defaults = MarkerConfig()
        cfg.markers = MarkerConfig(
            dictionary=mk.get("dictionary", defaults.dictionary),
            marker_size_m=float(mk.get("marker_size_m", defaults.marker_size_m)),
            world_markers={
                int(k): [float(x) for x in v]
                for k, v in mk.get("world_markers", {}).items()
            } if "world_markers" in mk else defaults.world_markers,
            robot_marker_ids=[int(x) for x in mk.get("robot_marker_ids", defaults.robot_marker_ids)],
            robot_head_marker_id=int(mk.get("robot_head_marker_id", defaults.robot_head_marker_id)),
            object_markers={
                int(k): str(v)
                for k, v in mk.get("object_markers", {}).items()
            } if "object_markers" in mk else defaults.object_markers,
        )
    if "stale_timeout_sec" in raw:
        cfg.stale_timeout_sec = float(raw["stale_timeout_sec"])
    return cfg
