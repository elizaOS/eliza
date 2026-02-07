"""Type definitions for plugin-prose."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ProseStateMode(str, Enum):
    """State management modes for OpenProse."""

    FILESYSTEM = "filesystem"
    IN_CONTEXT = "in-context"
    SQLITE = "sqlite"
    POSTGRES = "postgres"


@dataclass
class ProseRunOptions:
    """Options for running a prose program."""

    file: str
    state_mode: ProseStateMode = ProseStateMode.FILESYSTEM
    inputs_json: str | None = None
    cwd: str | None = None


@dataclass
class ProseCompileOptions:
    """Options for compiling/validating a prose program."""

    file: str


@dataclass
class ProseRunResult:
    """Result of running a prose program."""

    success: bool
    run_id: str | None = None
    outputs: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class ProseCompileResult:
    """Result of compiling/validating a prose program."""

    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class ProseSkillFile:
    """A skill file loaded by the prose service."""

    name: str
    path: str
    content: str


@dataclass
class ProseConfig:
    """Configuration for the Prose service."""

    workspace_dir: str = ".prose"
    default_state_mode: ProseStateMode = ProseStateMode.FILESYSTEM
    skills_dir: str | None = None
