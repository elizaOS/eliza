"""CLI plugin types.

Core type definitions for CLI command registration and execution.
All types are immutable dataclasses following the frozen pattern.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CliArg:
    """A single argument definition for a CLI command."""

    name: str
    """Argument name (e.g. 'output', 'verbose')."""
    description: str
    """Human-readable description."""
    required: bool = False
    """Whether this argument is required."""
    default_value: str | None = None
    """Optional default value when not supplied."""

    @classmethod
    def required_arg(cls, name: str, description: str) -> CliArg:
        """Create a required argument."""
        return cls(name=name, description=description, required=True)

    @classmethod
    def optional_arg(cls, name: str, description: str, default: str) -> CliArg:
        """Create an optional argument with a default value."""
        return cls(name=name, description=description, required=False, default_value=default)


@dataclass(frozen=True)
class CliCommand:
    """Definition of a CLI command that can be registered in the registry."""

    name: str
    """Primary command name (e.g. 'run', 'config')."""
    description: str
    """Human-readable description."""
    handler_name: str
    """Name of the handler function to invoke."""
    aliases: tuple[str, ...] = ()
    """Alternate names for this command."""
    args: tuple[CliArg, ...] = ()
    """Arguments accepted by this command."""
    priority: int = 100
    """Priority for registration order (lower = earlier)."""

    def matches(self, name: str) -> bool:
        """Check if this command matches a name or any of its aliases."""
        return self.name == name or name in self.aliases

    def with_alias(self, alias: str) -> CliCommand:
        """Return a new command with an additional alias."""
        return CliCommand(
            name=self.name,
            description=self.description,
            handler_name=self.handler_name,
            aliases=(*self.aliases, alias),
            args=self.args,
            priority=self.priority,
        )

    def with_arg(self, arg: CliArg) -> CliCommand:
        """Return a new command with an additional argument."""
        return CliCommand(
            name=self.name,
            description=self.description,
            handler_name=self.handler_name,
            aliases=self.aliases,
            args=(*self.args, arg),
            priority=self.priority,
        )

    def with_priority(self, priority: int) -> CliCommand:
        """Return a new command with a different priority."""
        return CliCommand(
            name=self.name,
            description=self.description,
            handler_name=self.handler_name,
            aliases=self.aliases,
            args=self.args,
            priority=priority,
        )


@dataclass(frozen=True)
class CliContext:
    """Context provided to CLI command handlers."""

    program_name: str
    """Program name (e.g. 'elizaos', 'otto')."""
    version: str
    """CLI version string."""
    description: str
    """Human-readable description of the CLI."""
    workspace_dir: str | None = None
    """Optional workspace directory for file operations."""
    config: dict[str, Any] | None = None
    """Optional configuration key-value pairs."""


class CliLogger(ABC):
    """Abstract logger interface for CLI output, allowing pluggable backends."""

    @abstractmethod
    def info(self, msg: str) -> None:
        """Log an informational message."""

    @abstractmethod
    def warn(self, msg: str) -> None:
        """Log a warning message."""

    @abstractmethod
    def error(self, msg: str) -> None:
        """Log an error message."""

    def debug(self, msg: str) -> None:
        """Log a debug message (optional, defaults to no-op)."""


class DefaultCliLogger(CliLogger):
    """Default logger that writes to stdout/stderr."""

    def info(self, msg: str) -> None:
        print(f"[INFO] {msg}")

    def warn(self, msg: str) -> None:
        print(f"[WARN] {msg}")

    def error(self, msg: str) -> None:
        import sys

        print(f"[ERROR] {msg}", file=sys.stderr)

    def debug(self, msg: str) -> None:
        print(f"[DEBUG] {msg}")


@dataclass
class ProgressReporter:
    """Tracks progress of a long-running operation."""

    current: int = 0
    """Current step number."""
    total: int = 0
    """Total number of steps (0 if unknown)."""
    message: str = ""
    """Current status message."""

    def __init__(self, total: int = 0, message: str = "") -> None:
        self.current = 0
        self.total = total
        self.message = message

    def advance(self, message: str) -> None:
        """Advance by one step with a new message."""
        self.current += 1
        self.message = message

    def set(self, current: int, message: str) -> None:
        """Set absolute progress."""
        self.current = current
        self.message = message

    def fraction(self) -> float | None:
        """Return progress as a fraction in [0.0, 1.0], or None if total is 0."""
        if self.total == 0:
            return None
        return self.current / self.total

    def is_complete(self) -> bool:
        """Whether the operation is complete."""
        return self.total > 0 and self.current >= self.total

    def display(self) -> str:
        """Format as a human-readable string like '[3/10] Building...'."""
        if self.total > 0:
            return f"[{self.current}/{self.total}] {self.message}"
        return f"[{self.current}] {self.message}"


@dataclass(frozen=True)
class CommonCommandOptions:
    """Common options that many CLI commands accept."""

    json: bool = False
    """Output as JSON."""
    verbose: bool = False
    """Verbose output."""
    quiet: bool = False
    """Quiet mode (minimal output)."""
    force: bool = False
    """Force action without confirmation."""
    dry_run: bool = False
    """Dry run (show what would happen)."""


@dataclass(frozen=True)
class ParsedDuration:
    """Result of parsing a duration string."""

    ms: int
    """Duration in milliseconds."""
    original: str
    """The original input string."""
    valid: bool
    """Whether parsing succeeded."""


@dataclass(frozen=True)
class CliPluginConfig:
    """CLI plugin configuration."""

    name: str = "elizaos"
    """CLI name."""
    version: str = "1.0.0"
    """CLI version."""
