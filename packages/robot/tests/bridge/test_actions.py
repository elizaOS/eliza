"""Tests for action playback library."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.isaaclab.actions import ACTION_LIBRARY, get_action, list_actions
from eliza_robot.bridge.isaaclab.joint_map import JOINT_BY_NAME


class ActionTests(unittest.TestCase):
    def test_list_actions(self) -> None:
        names = list_actions()
        self.assertIn("stand", names)
        self.assertIn("wave", names)
        self.assertIn("bow", names)
        self.assertIn("kick_right", names)
        self.assertIn("sit", names)
        self.assertIn("reset", names)

    def test_get_action(self) -> None:
        wave = get_action("wave")
        self.assertIsNotNone(wave)
        if wave is not None:
            self.assertEqual(wave.name, "wave")
            self.assertGreater(len(wave.keyframes), 0)

    def test_get_unknown_action(self) -> None:
        result = get_action("nonexistent_action")
        self.assertIsNone(result)

    def test_keyframe_joints_valid(self) -> None:
        for name, action in ACTION_LIBRARY.items():
            for i, kf in enumerate(action.keyframes):
                for joint_name in kf.positions:
                    self.assertIn(
                        joint_name,
                        JOINT_BY_NAME,
                        f"action '{name}' keyframe {i}: unknown joint '{joint_name}'",
                    )

    def test_keyframe_durations_positive(self) -> None:
        for name, action in ACTION_LIBRARY.items():
            for i, kf in enumerate(action.keyframes):
                self.assertGreater(
                    kf.duration_sec,
                    0.0,
                    f"action '{name}' keyframe {i}: non-positive duration",
                )

    def test_keyframe_positions_within_limits(self) -> None:
        for name, action in ACTION_LIBRARY.items():
            for i, kf in enumerate(action.keyframes):
                for joint_name, pos in kf.positions.items():
                    spec = JOINT_BY_NAME[joint_name]
                    self.assertGreaterEqual(
                        pos,
                        spec.lower_rad,
                        f"action '{name}' kf {i}: {joint_name}={pos} < {spec.lower_rad}",
                    )
                    self.assertLessEqual(
                        pos,
                        spec.upper_rad,
                        f"action '{name}' kf {i}: {joint_name}={pos} > {spec.upper_rad}",
                    )


if __name__ == "__main__":
    unittest.main()
