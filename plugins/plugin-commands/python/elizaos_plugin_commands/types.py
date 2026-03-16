"""Command system types."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class CommandCategory(Enum):
    """Categories for organizing commands."""

    GENERAL = "general"
    ADMIN = "admin"
    DEBUG = "debug"
    CUSTOM = "custom"

    def __str__(self) -> str:
        return self.value.capitalize()


@dataclass
class CommandDefinition:
    """Definition of a registerable command."""

    name: str
    description: str
    category: CommandCategory = CommandCategory.GENERAL
    usage: str = ""
    aliases: list[str] = field(default_factory=list)
    hidden: bool = False

    def __post_init__(self) -> None:
        self.name = self.name.lower()
        self.aliases = [a.lower() for a in self.aliases]
        if not self.usage:
            self.usage = f"/{self.name}"


@dataclass
class CommandContext:
    """Context available when executing a command."""

    runtime_id: str
    room_id: str
    agent_id: str


@dataclass
class CommandResult:
    """Result returned from a command handler."""

    success: bool
    text: str
    data: dict[str, Any] | None = None

    @classmethod
    def ok(cls, text: str, data: dict[str, Any] | None = None) -> CommandResult:
        """Create a successful result."""
        return cls(success=True, text=text, data=data)

    @classmethod
    def error(cls, text: str) -> CommandResult:
        """Create an error result."""
        return cls(success=False, text=text)


@dataclass
class ParsedCommand:
    """A parsed command extracted from user input."""

    name: str
    args: list[str]
    raw_text: str
