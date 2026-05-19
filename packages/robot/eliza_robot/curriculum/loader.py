"""Curriculum task loader.

`tasks.yaml` is the single source of truth for the text-conditioned RL
policy. This module:

  - parses tasks.yaml into validated Pydantic models
  - exposes lookup by task id, tier, and text variant
  - provides the canonical text-variant inventory for the encoder
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

TaskTier = Literal[1, 2, 3]


CURRICULUM_PATH = Path(__file__).parent / "tasks.yaml"


class TaskVerbs(BaseModel):
    """Per-language text variants for a single task."""

    model_config = ConfigDict(extra="allow", frozen=True)
    en: list[str] = Field(min_length=1)
    es: list[str] = Field(default_factory=list)
    fr: list[str] = Field(default_factory=list)
    ja: list[str] = Field(default_factory=list)
    zh: list[str] = Field(default_factory=list)

    def all_variants(self) -> list[str]:
        """Flatten every language's variants into one ordered list."""
        out: list[str] = []
        for field_name in self.model_fields:
            values = getattr(self, field_name, None)
            if isinstance(values, list):
                out.extend(values)
        # Extra fields (other languages added later via `extra="allow"`).
        for k, v in (self.__pydantic_extra__ or {}).items():
            if isinstance(v, list):
                out.extend(v)
        return out


class TaskSpec(BaseModel):
    """One curriculum task."""

    model_config = ConfigDict(extra="allow", frozen=True)

    id: str
    tier: TaskTier
    verbs: TaskVerbs
    description: str
    reward: dict
    success: dict
    max_episode_s: float = 8.0
    action_dim: int = 24
    requires_target: bool = False
    init_state: str | None = None

    @field_validator("id")
    @classmethod
    def _id_kebab(cls, v: str) -> str:
        if not v.replace("_", "").replace("-", "").isalnum():
            raise ValueError(f"task id {v!r} must be alphanumeric + _/-")
        return v


class Curriculum(BaseModel):
    """Top-level curriculum manifest."""

    model_config = ConfigDict(frozen=True)
    version: int
    default_action_dim: int = 24
    default_max_episode_s: float = 8.0
    tiers: dict[int, dict]
    tasks: list[TaskSpec]

    def by_id(self, task_id: str) -> TaskSpec:
        for t in self.tasks:
            if t.id == task_id:
                return t
        raise KeyError(f"no curriculum task with id={task_id!r}")

    def by_tier(self, tier: TaskTier) -> list[TaskSpec]:
        return [t for t in self.tasks if t.tier == tier]

    def all_ids(self) -> list[str]:
        return [t.id for t in self.tasks]

    def find_by_text(self, text: str) -> TaskSpec | None:
        """Case-insensitive substring match across every text variant.
        Returns the first matching task or None.
        """
        needle = text.lower().strip()
        for task in self.tasks:
            for variant in task.verbs.all_variants():
                if variant.lower() == needle:
                    return task
        # Loose substring match as a fallback.
        for task in self.tasks:
            for variant in task.verbs.all_variants():
                if variant.lower() in needle or needle in variant.lower():
                    return task
        return None

    def text_variant_inventory(self) -> dict[str, list[str]]:
        """Map task_id → all text variants across all languages."""
        return {t.id: t.verbs.all_variants() for t in self.tasks}


@lru_cache(maxsize=1)
def load_curriculum(path: Path | None = None) -> Curriculum:
    """Load tasks.yaml (cached)."""
    p = path or CURRICULUM_PATH
    with p.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    return Curriculum.model_validate(raw)


__all__ = [
    "Curriculum",
    "TaskSpec",
    "TaskVerbs",
    "load_curriculum",
    "CURRICULUM_PATH",
]
