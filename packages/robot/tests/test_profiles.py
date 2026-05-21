"""Tests for the eliza_robot profile registry + schema."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from eliza_robot.profiles import (
    DEFAULT_PROFILE_ID,
    list_profiles,
    load_profile,
)
from eliza_robot.profiles.schema import RobotProfile


def test_default_profile_id_is_hiwonder() -> None:
    assert DEFAULT_PROFILE_ID == "hiwonder-ainex"


def test_default_profile_is_listed() -> None:
    profiles = list_profiles()
    assert DEFAULT_PROFILE_ID in profiles


def test_load_hiwonder_profile_returns_robot_profile() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    assert isinstance(profile, RobotProfile)
    assert profile.id == DEFAULT_PROFILE_ID
    assert profile.name == "Hiwonder AiNex"


def test_hiwonder_profile_has_24_joints() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    assert profile.kinematics.dof == 24
    assert len(profile.kinematics.joints) == 24


def test_hiwonder_joint_limits_within_pi() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    for joint in profile.kinematics.joints:
        assert joint.lower_rad >= -math.pi, (
            f"{joint.name} lower={joint.lower_rad} below -pi"
        )
        assert joint.upper_rad <= math.pi, (
            f"{joint.name} upper={joint.upper_rad} above +pi"
        )
        assert joint.lower_rad < joint.upper_rad
        assert joint.lower_rad <= joint.home_rad <= joint.upper_rad


def test_hiwonder_joint_indices_are_contiguous_permutation() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    indices = sorted(j.index for j in profile.kinematics.joints)
    assert indices == list(range(profile.kinematics.dof))


def test_hiwonder_joint_groups_match_inventory() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    by_group: dict[str, int] = {}
    for j in profile.kinematics.joints:
        by_group[j.group] = by_group.get(j.group, 0) + 1
    assert by_group == {"LEG": 12, "HEAD": 2, "ARM": 10}


def test_hiwonder_has_at_least_one_camera() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    assert len(profile.sensors.cameras) >= 1
    cam = profile.sensors.cameras[0]
    assert cam.width > 0 and cam.height > 0 and cam.fps > 0
    assert 0 < cam.fov_deg < 360


def test_hiwonder_gait_controller_is_supported() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    assert profile.gait.controller in {"bezier", "rl", "openpi"}


def test_hiwonder_action_library_has_core_gestures() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    expected = {"stand", "sit", "wave", "bow"}
    assert expected.issubset(profile.actions.groups.keys())
    for group in profile.actions.groups.values():
        assert group.duration_s > 0
        assert len(group.frames) >= 1
        assert group.frames[0].t == 0.0
        assert group.frames[-1].t <= group.duration_s


def test_hiwonder_safety_envelope_is_sane() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    assert profile.safety.fall_pitch_rad > 0
    assert profile.safety.fall_roll_rad > 0
    assert profile.safety.battery_low_mv > 0
    assert profile.safety.deadman_timeout_s > 0


def test_hiwonder_bridge_capabilities_match_protocol() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    required = {"walk.set", "walk.command", "head.set", "action.play", "servo.set"}
    assert required.issubset(profile.bridge_capabilities)


def test_asset_paths_resolved_to_absolute() -> None:
    profile = load_profile(DEFAULT_PROFILE_ID)
    for path in (
        profile.assets.mjcf_xml,
        profile.assets.mjx_xml,
        profile.assets.urdf,
        profile.assets.mesh_dir,
    ):
        assert isinstance(path, Path)
        assert path.is_absolute(), f"{path} should be absolute"
        # Asset files are populated by W2.2 — we only check the location.
        assert "assets/profiles/hiwonder-ainex" in str(path)


def test_load_unknown_profile_raises() -> None:
    with pytest.raises(FileNotFoundError):
        load_profile("does-not-exist")


# ---------------------------------------------------------------------------
# Multi-robot profile registry: every supported profile must load cleanly.
# ---------------------------------------------------------------------------

SUPPORTED_PROFILE_IDS = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1")
EXPECTED_DOF = {
    "hiwonder-ainex": 24,
    "asimov-1": 25,
    "unitree-g1": 29,
    "unitree-h1": 19,
}


@pytest.mark.parametrize("profile_id", SUPPORTED_PROFILE_IDS)
def test_supported_profile_loads(profile_id: str) -> None:
    profile = load_profile(profile_id)
    assert isinstance(profile, RobotProfile)
    assert profile.id == profile_id
    assert profile.kinematics.dof == EXPECTED_DOF[profile_id]
    assert len(profile.kinematics.joints) == profile.kinematics.dof


@pytest.mark.parametrize("profile_id", SUPPORTED_PROFILE_IDS)
def test_supported_profile_joint_indices_are_contiguous(profile_id: str) -> None:
    profile = load_profile(profile_id)
    indices = sorted(j.index for j in profile.kinematics.joints)
    assert indices == list(range(profile.kinematics.dof))


@pytest.mark.parametrize("profile_id", SUPPORTED_PROFILE_IDS)
def test_supported_profile_joint_limits_within_two_pi(profile_id: str) -> None:
    profile = load_profile(profile_id)
    for j in profile.kinematics.joints:
        assert -2 * math.pi <= j.lower_rad < j.upper_rad <= 2 * math.pi
        assert j.lower_rad <= j.home_rad <= j.upper_rad


@pytest.mark.parametrize("profile_id", SUPPORTED_PROFILE_IDS)
def test_supported_profile_has_ego_camera(profile_id: str) -> None:
    profile = load_profile(profile_id)
    cams = profile.sensors.cameras
    # Every supported humanoid declares at least one robot-mounted RGB
    # camera for the ego-pose observation channel + perception module.
    # Mount link varies per robot (head_tilt_link on AiNex, torso on
    # Unitree, pelvis_link on Asimov) — we only require one exists with
    # a valid mount link and resolution.
    assert cams, f"{profile_id} declares no cameras"
    cam = cams[0]
    assert cam.mount_link, f"{profile_id} camera has no mount_link"
    assert cam.width > 0 and cam.height > 0 and cam.fps > 0


@pytest.mark.parametrize("profile_id", SUPPORTED_PROFILE_IDS)
def test_supported_profile_assets_exist_on_disk(profile_id: str) -> None:
    profile = load_profile(profile_id)
    assert profile.assets.mjcf_xml.is_file(), f"missing {profile.assets.mjcf_xml}"
    assert profile.assets.mesh_dir.is_dir(), f"missing {profile.assets.mesh_dir}"


@pytest.mark.parametrize("profile_id", SUPPORTED_PROFILE_IDS)
def test_supported_profile_loads_in_mujoco(profile_id: str) -> None:
    """The canonical MJCF must compile under MuJoCo with the documented DoF."""
    mujoco = pytest.importorskip("mujoco")
    profile = load_profile(profile_id)
    model = mujoco.MjModel.from_xml_path(str(profile.assets.mjcf_xml))
    assert model.nu == profile.kinematics.dof, (
        f"{profile_id} MJCF actuator count {model.nu} != profile dof {profile.kinematics.dof}"
    )
