"""Skill library for eliza_robot — RL-trained and scripted skills.

Re-exports the core skill primitives and a default registry populated with
the skills that can run without external bridge modules. Skills that depend
on `eliza_robot.bridge.isaaclab` (StandSkill, BowSkill, WaveSkill,
WalkSkill, TurnSkill) are importable on demand from their submodules but
are not added to the default registry until the bridge port lands.
"""

from __future__ import annotations

from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus
from eliza_robot.rl.skills.brax_target_skill import BraxTargetSkill
from eliza_robot.rl.skills.brax_walk_skill import BraxWalkSkill
from eliza_robot.rl.skills.composite_skill import CompositeSkill, UpperBodySkill
from eliza_robot.rl.skills.registry import DEFAULT_ALIASES, SkillRegistry
from eliza_robot.rl.skills.rl_wave_skill import RLWaveSkill


def build_default_registry() -> SkillRegistry:
    """Construct a SkillRegistry populated with the bridge-free skills.

    The Brax-backed skills here all degrade gracefully when their checkpoint
    is absent (zero / fallback actions), so they can be registered without
    a checkpoint store being mounted. The scripted skills that depend on
    the AiNex bridge keyframe library are intentionally left out of the
    default set; load them explicitly once the bridge port is wired up.
    """
    registry = SkillRegistry()
    registry.register(BraxWalkSkill())
    registry.register(BraxTargetSkill())
    registry.register(RLWaveSkill())
    return registry


__all__ = [
    "BaseSkill",
    "BraxTargetSkill",
    "BraxWalkSkill",
    "CompositeSkill",
    "DEFAULT_ALIASES",
    "RLWaveSkill",
    "SkillParams",
    "SkillRegistry",
    "SkillStatus",
    "UpperBodySkill",
    "build_default_registry",
]
