"""Multi-camera perception: extrinsic calibration, dual-camera sync, entity fusion.

Extends the single-camera perception pipeline with:
- ArUco-based extrinsic calibration for external cameras
- Synchronized dual-camera frame capture
- World-frame entity fusion across multiple viewpoints
"""

from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics, ExtrinsicCalibrator
from eliza_robot.perception.multicam.dual_camera import DualCameraSource, SyncedFrame
from eliza_robot.perception.multicam.entity_fusion import FusedWorldState

__all__ = [
    "CameraExtrinsics",
    "ExtrinsicCalibrator",
    "DualCameraSource",
    "SyncedFrame",
    "FusedWorldState",
]
