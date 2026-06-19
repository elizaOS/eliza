"""Tests for RLWaveSkill — the RL-trained wave policy."""

from __future__ import annotations

import time

import numpy as np

from eliza_robot.rl.skills.base import SkillParams, SkillStatus
from eliza_robot.rl.skills.composite_skill import NUM_TOTAL_JOINTS
from eliza_robot.rl.skills.registry import SkillRegistry
from eliza_robot.rl.skills.rl_wave_skill import (
    TASK_OBS_DIM,
    WAVE_AMPLITUDE,
    WAVE_ELBOW_PITCH,
    WAVE_FREQUENCY,
    WAVE_SHOULDER_PITCH,
    RLWaveSkill,
)


class TestRLWaveSkillInit:
    def test_fallback_when_no_checkpoint(self, tmp_path):
        """Falls back when checkpoint missing; scripted fallback may also be unavailable."""
        skill = RLWaveSkill(
            walking_checkpoint=str(tmp_path / "nonexistent_walk"),
            wave_checkpoint=str(tmp_path / "nonexistent_wave"),
        )
        assert skill.using_fallback is True
        assert skill.composite is None


class TestTaskObservation:
    def test_task_obs_shape(self):
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent")
        obs = skill._compute_task_obs(0.0)
        assert obs.shape == (TASK_OBS_DIM,)
        assert obs.dtype == np.float32

    def test_task_obs_at_zero(self):
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent")
        obs = skill._compute_task_obs(0.0)
        assert abs(obs[0]) < 1e-6
        assert abs(obs[1] - 1.0) < 1e-6
        assert abs(obs[2] - WAVE_SHOULDER_PITCH) < 1e-6
        assert abs(obs[3]) < 1e-6
        assert abs(obs[4] - WAVE_ELBOW_PITCH) < 1e-6

    def test_task_obs_quarter_period(self):
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent")
        t = 1.0 / (4.0 * WAVE_FREQUENCY)
        obs = skill._compute_task_obs(t)
        assert abs(obs[0] - 1.0) < 1e-5
        assert abs(obs[1]) < 1e-5
        assert abs(obs[3] - WAVE_AMPLITUDE) < 1e-5


class TestGetActionZeroFallback:
    """When fallback scripted skill is unavailable, RL path returns zeros."""

    def test_completes_after_duration(self):
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent", duration_sec=0.01)
        skill.reset()
        time.sleep(0.02)
        skill._using_fallback = False
        skill._composite = None
        action, status = skill.get_action_from_telemetry()
        assert status == SkillStatus.COMPLETED
        assert action.shape == (NUM_TOTAL_JOINTS,)

    def test_reset_with_custom_duration(self):
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent", duration_sec=5.0)
        params = SkillParams(duration_sec=2.0)
        skill.reset(params)
        assert skill._duration == 2.0

    def test_reset_without_params_uses_default(self):
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent", duration_sec=5.0)
        skill.reset()
        assert skill._duration == 5.0


class TestRegistryIntegration:
    def test_registry_lookup(self):
        registry = SkillRegistry()
        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent")
        registry.register(skill)

        assert registry.get("wave") is skill
        assert registry.get("wave hello") is skill
        assert registry.get("greet") is skill
        assert registry.get("say hello") is skill
