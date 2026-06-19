"""Tests for AiNex IsaacLab configuration."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.isaaclab.ainex_cfg import (
    STAND_JOINT_POSITIONS,
    build_ainex_cfg,
    build_joint_limits,
)
from eliza_robot.bridge.isaaclab.joint_map import JOINT_NAMES, NUM_JOINTS


class AiNexCfgTests(unittest.TestCase):
    def test_build_joint_limits(self) -> None:
        limits = build_joint_limits()
        self.assertEqual(len(limits), NUM_JOINTS)
        for name in JOINT_NAMES:
            self.assertIn(name, limits)
            lim = limits[name]
            self.assertLess(lim.lower, lim.upper)
            self.assertGreater(lim.effort, 0)
            self.assertGreater(lim.velocity, 0)

    def test_stand_positions_valid(self) -> None:
        limits = build_joint_limits()
        for name, pos in STAND_JOINT_POSITIONS.items():
            self.assertIn(name, limits, f"unknown joint in standing pose: {name}")
            lim = limits[name]
            self.assertGreaterEqual(pos, lim.lower, f"{name}={pos} < lower={lim.lower}")
            self.assertLessEqual(pos, lim.upper, f"{name}={pos} > upper={lim.upper}")

    def test_stand_positions_complete(self) -> None:
        for name in JOINT_NAMES:
            self.assertIn(name, STAND_JOINT_POSITIONS, f"missing standing pose for: {name}")

    def test_build_cfg(self) -> None:
        cfg = build_ainex_cfg()
        self.assertEqual(cfg.spawn_height, 0.25)
        self.assertEqual(len(cfg.leg_actuators.joint_names), 12)
        self.assertEqual(len(cfg.arm_actuators.joint_names), 10)
        self.assertEqual(len(cfg.head_actuators.joint_names), 2)
        self.assertEqual(len(cfg.joint_limits), NUM_JOINTS)
        self.assertEqual(len(cfg.default_positions), NUM_JOINTS)

    def test_try_build_isaaclab_returns_none_without_isaac(self) -> None:
        from eliza_robot.bridge.isaaclab.ainex_cfg import try_build_isaaclab_articulation_cfg

        result = try_build_isaaclab_articulation_cfg()
        # Without Isaac Sim, this should return None gracefully.
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
