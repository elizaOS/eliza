"""MuJoCo camera rendering matching real camera parameters.

Renders from the head_cam camera in MuJoCo, producing images that
match the real USB camera's resolution and field of view.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics


# Camera name in MJCF files
HEAD_CAM_NAME = "head_cam"
# Default fovy matching MJCF
DEFAULT_FOVY = 49.1


class SimCamera:
    """Render camera images from MuJoCo simulation."""

    def __init__(
        self,
        model: Any,  # mujoco.MjModel
        data: Any,    # mujoco.MjData
        camera_name: str = HEAD_CAM_NAME,
        width: int = 640,
        height: int = 480,
    ) -> None:
        import mujoco
        self._model = model
        self._data = data
        self._camera_name = camera_name
        self._width = width
        self._height = height
        self._renderer = mujoco.Renderer(model, height=height, width=width)

    def render_rgb(self, data: Any | None = None) -> np.ndarray:
        """Render RGB image from the head camera. Returns (H, W, 3) uint8 BGR."""
        import mujoco
        d = data if data is not None else self._data
        self._renderer.update_scene(d, camera=self._camera_name)
        rgb = self._renderer.render()  # (H, W, 3) RGB
        # Convert RGB to BGR to match OpenCV convention
        return rgb[:, :, ::-1].copy()

    def render_depth(self, data: Any | None = None) -> np.ndarray:
        """Render depth image from the head camera. Returns (H, W) float32 meters."""
        import mujoco
        d = data if data is not None else self._data
        self._renderer.update_scene(d, camera=self._camera_name)
        self._renderer.enable_depth_rendering()
        depth = self._renderer.render()  # (H, W) float32
        self._renderer.disable_depth_rendering()
        return depth.copy()

    def get_intrinsics(self) -> CameraIntrinsics:
        """Compute camera intrinsics from MuJoCo camera parameters."""
        import mujoco
        cam_id = mujoco.mj_name2id(self._model, mujoco.mjtObj.mjOBJ_CAMERA, self._camera_name)
        fovy = self._model.cam_fovy[cam_id] if cam_id >= 0 else DEFAULT_FOVY
        fy = self._height / (2.0 * np.tan(np.radians(fovy / 2.0)))
        fx = fy  # square pixels
        return CameraIntrinsics(
            fx=float(fx),
            fy=float(fy),
            cx=self._width / 2.0,
            cy=self._height / 2.0,
            width=self._width,
            height=self._height,
        )

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    def close(self) -> None:
        self._renderer.close()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
