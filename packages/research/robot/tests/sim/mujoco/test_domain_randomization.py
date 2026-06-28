"""Tests for domain randomization module."""

import mujoco
import numpy as np
import pytest

from eliza_robot.sim.mujoco.domain_randomization import DomainRandomization, PRESETS
from eliza_robot.sim.mujoco import ainex_constants as consts


class TestPresets:
    def test_all_presets_exist(self):
        expected = {"none", "light", "moderate", "aggressive", "real_world"}
        assert set(PRESETS.keys()) == expected

    def test_from_preset(self):
        dr = DomainRandomization.from_preset("moderate")
        assert dr.name == "moderate"
        assert dr.friction_range == (0.5, 1.5)

    def test_from_preset_invalid(self):
        with pytest.raises(ValueError, match="Unknown preset"):
            DomainRandomization.from_preset("nonexistent")

    def test_none_preset_is_identity(self):
        dr = DomainRandomization.from_preset("none")
        assert dr.friction_range == (1.0, 1.0)
        assert dr.mass_scale_range == (1.0, 1.0)
        assert dr.joint_stiffness_scale == (1.0, 1.0)
        assert dr.joint_damping_scale == (1.0, 1.0)

    def test_aggressive_wider_than_light(self):
        light = DomainRandomization.from_preset("light")
        aggressive = DomainRandomization.from_preset("aggressive")
        # Aggressive should have wider friction range
        assert aggressive.friction_range[0] < light.friction_range[0]
        assert aggressive.friction_range[1] > light.friction_range[1]


class TestRandomizeModel:
    @pytest.fixture
    def model(self):
        return mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))

    def test_none_preset_no_change(self, model):
        dr = DomainRandomization.from_preset("none")
        friction_before = model.geom_friction[:, 0].copy()
        mass_before = model.body_mass.copy()
        rng = np.random.default_rng(42)
        dr.randomize_model(model, rng)
        np.testing.assert_array_equal(model.geom_friction[:, 0], friction_before)
        np.testing.assert_array_equal(model.body_mass, mass_before)

    def test_moderate_changes_friction(self, model):
        dr = DomainRandomization.from_preset("moderate")
        friction_before = model.geom_friction[:, 0].copy()
        rng = np.random.default_rng(42)
        dr.randomize_model(model, rng)
        assert not np.array_equal(model.geom_friction[:, 0], friction_before)

    def test_moderate_changes_mass(self, model):
        dr = DomainRandomization.from_preset("moderate")
        mass_before = model.body_mass.copy()
        rng = np.random.default_rng(42)
        dr.randomize_model(model, rng)
        # Body 0 is world (unchanged), bodies 1+ should change
        assert not np.array_equal(model.body_mass[1:], mass_before[1:])

    def test_moderate_changes_stiffness(self, model):
        dr = DomainRandomization.from_preset("moderate")
        gain_before = model.actuator_gainprm[:, 0].copy()
        rng = np.random.default_rng(42)
        dr.randomize_model(model, rng)
        assert not np.array_equal(model.actuator_gainprm[:, 0], gain_before)

    def test_moderate_changes_damping(self, model):
        dr = DomainRandomization.from_preset("moderate")
        damping_before = model.dof_damping[6:].copy()
        rng = np.random.default_rng(42)
        dr.randomize_model(model, rng)
        assert not np.array_equal(model.dof_damping[6:], damping_before)

    def test_freejoint_damping_unchanged(self, model):
        dr = DomainRandomization.from_preset("aggressive")
        damping_before = model.dof_damping[:6].copy()
        rng = np.random.default_rng(42)
        dr.randomize_model(model, rng)
        np.testing.assert_array_equal(model.dof_damping[:6], damping_before)

    def test_deterministic_with_same_seed(self, model):
        dr = DomainRandomization.from_preset("moderate")
        model2 = mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))
        rng1 = np.random.default_rng(42)
        rng2 = np.random.default_rng(42)
        dr.randomize_model(model, rng1)
        dr.randomize_model(model2, rng2)
        np.testing.assert_array_equal(model.geom_friction, model2.geom_friction)
        np.testing.assert_array_equal(model.body_mass, model2.body_mass)
