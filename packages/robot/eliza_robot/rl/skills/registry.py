"""Skill registry — dispatch skills by name or alias.

Ported from `training.rl.skills.registry`. The registry is used both
internally (composite + deploy harnesses) and by `plugin-ainex` actions
which need to look up a skill by user-facing name.
"""

from __future__ import annotations

from eliza_robot.rl.skills.base import BaseSkill


# Alias map: common phrases → canonical skill name.
DEFAULT_ALIASES: dict[str, str] = {
    "go forward": "walk",
    "go backwards": "walk",
    "move forward": "walk",
    "move": "walk",
    "walk forward": "walk",
    "walk backward": "walk",
    "walk slowly": "walk",
    "walk fast": "walk",
    "stop": "stand",
    "halt": "stand",
    "freeze": "stand",
    "turn left": "turn",
    "turn right": "turn",
    "rotate": "turn",
    "spin": "turn",
    "wave hello": "wave",
    "wave hand": "wave",
    "say hello": "wave",
    "greet": "wave",
    "bow down": "bow",
    "take a bow": "bow",
    # Target-reaching aliases
    "walk to target": "walk_to_target",
    "go to": "walk_to_target",
    "navigate to": "walk_to_target",
    "approach": "walk_to_target",
    # Grasp / manipulation aliases
    "grab": "grasp",
    "pick up": "grasp",
    "grab object": "grasp",
    "grasp object": "grasp",
    "reach for": "grasp",
    # Carry aliases
    "carry object": "carry",
    "bring": "carry",
    "bring object": "carry",
    "fetch": "carry",
    "deliver": "carry",
}


class SkillRegistry:
    """Registry of available skills with alias support."""

    def __init__(self) -> None:
        self._skills: dict[str, BaseSkill] = {}
        self._aliases: dict[str, str] = dict(DEFAULT_ALIASES)

    def register(self, skill: BaseSkill) -> None:
        """Register a skill by its name."""
        self._skills[skill.name] = skill

    def get(self, name: str) -> BaseSkill | None:
        """Look up a skill by name or alias."""
        if name in self._skills:
            return self._skills[name]
        canonical = self._aliases.get(name.lower())
        if canonical and canonical in self._skills:
            return self._skills[canonical]
        return None

    def list_skills(self) -> list[str]:
        """Return all registered skill names."""
        return sorted(self._skills.keys())

    def add_alias(self, alias: str, skill_name: str) -> None:
        """Add a custom alias mapping."""
        self._aliases[alias.lower()] = skill_name

    def __contains__(self, name: str) -> bool:
        return self.get(name) is not None

    def __len__(self) -> int:
        return len(self._skills)
