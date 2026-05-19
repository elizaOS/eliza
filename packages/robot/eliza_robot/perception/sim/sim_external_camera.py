"""Overhead / external camera in MuJoCo simulation.

Renders a second viewpoint for multi-camera perception training,
matching the real external camera setup. Provides both RGB and
depth rendering plus ground-truth intrinsics and extrinsics.
"""

from __future__ import annotations

import logging

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics

try:
    import mujoco
    _HAS_MUJOCO = True
except ImportError:
    mujoco = None  # type: ignore[assignment]
    _HAS_MUJOCO = False

logger = logging.getLogger(__name__)


class SimExternalCamera:
    """Renders an overhead / external camera view from MuJoCo.

    Provides a second viewpoint for multi-camera perception training
    in simulation, matching the real external camera setup.

    Usage:
        cam = SimExternalCamera(model, data, camera_name="external_cam")
        rgb, depth = cam.render()
        intrinsics = cam.intrinsics
        extrinsics = cam.extrinsics
    """

    def __init__(
        self,
        model,  # mujoco.MjModel
        data,   # mujoco.MjData
        camera_name: str = "external_cam",
        width: int = 1280,
        height: int = 720,
    ) -> None:
        if not _HAS_MUJOCO:
            raise RuntimeError("MuJoCo required for SimExternalCamera")

        self._model = model
        self._data = data
        self._camera_name = camera_name
        self._width = width
        self._height = height

        # Look up the camera ID from the model
        self._camera_id = mujoco.mj_name2id(
            model, mujoco.mjtObj.mjOBJ_CAMERA, camera_name
        )
        if self._camera_id < 0:
            raise ValueError(
                f"Camera '{camera_name}' not found in MuJoCo model. "
                f"Add a <camera> element to your MJCF."
            )

        # Create renderer
        self._renderer = mujoco.Renderer(model, height=height, width=width)

    def render(self) -> tuple[np.ndarray, np.ndarray]:
        """Render RGB + depth from the external camera.

        Returns
        -------
        rgb : np.ndarray
            (H, W, 3) uint8 RGB image.
        depth : np.ndarray
            (H, W) float32 depth in meters.
        """
        self._renderer.update_scene(self._data, camera=self._camera_name)

        # RGB
        rgb = self._renderer.render()

        # Depth
        self._renderer.enable_depth_rendering(True)
        self._renderer.update_scene(self._data, camera=self._camera_name)
        depth_raw = self._renderer.render()
        self._renderer.enable_depth_rendering(False)

        # Convert MuJoCo depth buffer to metric depth
        # MuJoCo returns linear depth in [near, far] range
        extent = self._model.stat.extent
        near = self._model.vis.map.znear * extent
        far = self._model.vis.map.zfar * extent

        # Linearize depth buffer
        depth = near / (1.0 - depth_raw * (1.0 - near / far))
        depth = depth.astype(np.float32)

        return rgb.copy(), depth

    @property
    def intrinsics(self) -> CameraIntrinsics:
        """Extract camera intrinsics from MuJoCo model."""
        fovy = float(self._model.cam_fovy[self._camera_id])
        # fovy is vertical field of view in degrees
        fovy_rad = np.deg2rad(fovy)
        fy = self._height / (2.0 * np.tan(fovy_rad / 2.0))
        fx = fy  # Assumes square pixels
        cx = self._width / 2.0
        cy = self._height / 2.0

        return CameraIntrinsics(
            fx=float(fx),
            fy=float(fy),
            cx=float(cx),
            cy=float(cy),
            width=self._width,
            height=self._height,
            dist_coeffs=(0.0, 0.0, 0.0, 0.0, 0.0),  # No distortion in sim
        )

    @property
    def extrinsics(self) -> CameraExtrinsics:
        """Get camera extrinsics from MuJoCo model (exact ground truth).

        The camera pose is extracted from the model's camera body, giving
        the exact camera-to-world transform.
        """
        # Camera position in world frame
        pos = self._data.cam_xpos[self._camera_id].copy()

        # Camera orientation: MuJoCo stores as 3x3 rotation matrix
        # cam_xmat is stored row-major as 9 elements
        R_world_from_cam_mj = self._data.cam_xmat[self._camera_id].reshape(3, 3).copy()

        # MuJoCo camera convention: -Z is the viewing direction
        # OpenCV camera convention: +Z is the viewing direction
        # We need to flip Z and Y axes
        correction = np.array([
            [1, 0, 0],
            [0, -1, 0],
            [0, 0, -1],
        ], dtype=np.float64)

        R_cam_to_world = R_world_from_cam_mj @ correction

        return CameraExtrinsics(
            camera_id=self._camera_name,
            R=R_cam_to_world,
            t=pos,
            timestamp=float(self._data.time),
            reprojection_error=0.0,  # Perfect in simulation
        )

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    def close(self) -> None:
        """Clean up the renderer."""
        if hasattr(self, "_renderer"):
            self._renderer.close()
