"""Tests for sensor frame correctness in AiNex MJCF models.

Verifies that global_linvel/global_angvel sensors return world-frame data
and local_linvel returns body-frame data, as required by the reward functions.
"""

import math

import mujoco
import numpy as np
import pytest

from eliza_robot.sim.mujoco import ainex_constants as consts


@pytest.fixture(scope="module")
def model():
    return mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))


@pytest.fixture
def data(model):
    return mujoco.MjData(model)


def _read_sensor(model, data, name):
    sid = model.sensor(name).id
    adr = model.sensor_adr[sid]
    dim = model.sensor_dim[sid]
    return data.sensordata[adr : adr + dim].copy()


class TestSensorTypes:
    """Verify sensor types match the OP3 Playground pattern."""

    def test_global_linvel_is_framelinvel(self, model):
        sid = model.sensor("global_linvel").id
        assert model.sensor_type[sid] == 31  # framelinvel

    def test_global_angvel_is_frameangvel(self, model):
        sid = model.sensor("global_angvel").id
        assert model.sensor_type[sid] == 32  # frameangvel

    def test_local_linvel_is_velocimeter(self, model):
        sid = model.sensor("local_linvel").id
        assert model.sensor_type[sid] == 2  # velocimeter

    def test_gyro_is_gyro(self, model):
        sid = model.sensor("gyro").id
        assert model.sensor_type[sid] == 3  # gyro


class TestSensorFrames:
    """Verify that global and local sensors differ when robot is rotated."""

    def test_global_vs_local_linvel_differ_when_rotated(self, model, data):
        """With robot rotated 45deg and moving in world +x,
        global should show [0.5, 0, 0] and local should show [0.354, -0.354, 0]."""
        qpos = model.keyframe("stand").qpos.copy()

        # Rotate 45 degrees around z
        angle = math.pi / 4
        qpos[3] = math.cos(angle / 2)  # qw
        qpos[4] = 0  # qx
        qpos[5] = 0  # qy
        qpos[6] = math.sin(angle / 2)  # qz

        data.qpos[:] = qpos
        data.qvel[0] = 0.5  # world +x velocity
        data.ctrl[:] = qpos[7:]
        mujoco.mj_step(model, data)

        gl = _read_sensor(model, data, "global_linvel")
        ll = _read_sensor(model, data, "local_linvel")

        # They must be different
        assert not np.allclose(gl, ll, atol=0.01), \
            f"global_linvel {gl} and local_linvel {ll} should differ when rotated"

        # Global should be approximately in world x direction
        assert abs(gl[0]) > 0.3, f"global_linvel x should be ~0.5, got {gl[0]}"
        assert abs(gl[1]) < 0.1, f"global_linvel y should be ~0.0, got {gl[1]}"

    def test_global_linvel_world_z(self, model, data):
        """Vertical velocity should show in global_linvel[2]."""
        qpos = model.keyframe("stand").qpos.copy()
        data.qpos[:] = qpos
        data.qvel[2] = 0.3  # world +z velocity
        data.ctrl[:] = qpos[7:]
        mujoco.mj_step(model, data)

        gl = _read_sensor(model, data, "global_linvel")
        assert abs(gl[2]) > 0.1, f"global_linvel z should reflect vertical velocity, got {gl[2]}"


class TestAllXmlsConsistent:
    """Verify all three XML files have correct sensor types."""

    @pytest.mark.parametrize("xml_path", [
        consts.SCENE_PRIMITIVES_XML,
        consts.SCENE_MJX_XML,
        consts.SCENE_XML,
    ])
    def test_global_linvel_type(self, xml_path):
        m = mujoco.MjModel.from_xml_path(str(xml_path))
        sid = m.sensor("global_linvel").id
        assert m.sensor_type[sid] == 31, \
            f"{xml_path.name}: global_linvel should be framelinvel (31), got {m.sensor_type[sid]}"

    @pytest.mark.parametrize("xml_path", [
        consts.SCENE_PRIMITIVES_XML,
        consts.SCENE_MJX_XML,
        consts.SCENE_XML,
    ])
    def test_global_angvel_type(self, xml_path):
        m = mujoco.MjModel.from_xml_path(str(xml_path))
        sid = m.sensor("global_angvel").id
        assert m.sensor_type[sid] == 32, \
            f"{xml_path.name}: global_angvel should be frameangvel (32), got {m.sensor_type[sid]}"
