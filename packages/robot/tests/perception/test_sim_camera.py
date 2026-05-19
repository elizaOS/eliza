"""Tests for sim camera module."""

from __future__ import annotations

import numpy as np
import pytest

mujoco = pytest.importorskip("mujoco")

from eliza_robot.perception.sim.sim_camera import SimCamera


@pytest.fixture
def sim_model_data():
    """Load AiNex primitives model for testing."""
    from eliza_robot.mujoco.ainex_constants import SCENE_PRIMITIVES_XML
    model = mujoco.MjModel.from_xml_path(str(SCENE_PRIMITIVES_XML))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    return model, data


class TestSimCamera:
    def test_render_shape(self, sim_model_data):
        model, data = sim_model_data
        cam = SimCamera(model, data, width=640, height=480)
        try:
            rgb = cam.render_rgb()
            assert rgb.shape == (480, 640, 3)
            assert rgb.dtype == np.uint8
        finally:
            cam.close()

    def test_depth_positive(self, sim_model_data):
        model, data = sim_model_data
        cam = SimCamera(model, data, width=640, height=480)
        try:
            depth = cam.render_depth()
            assert depth.shape == (480, 640)
            assert depth.dtype == np.float32
        finally:
            cam.close()

    def test_intrinsics_fovy(self, sim_model_data):
        model, data = sim_model_data
        cam = SimCamera(model, data, width=640, height=480)
        try:
            intr = cam.get_intrinsics()
            assert intr.width == 640
            assert intr.height == 480
            assert intr.fx > 0
            assert intr.fy > 0
            # HFOV should be ~62 deg (matching 49.1 fovy at 640x480)
            assert 50 < intr.hfov_deg < 75
        finally:
            cam.close()
