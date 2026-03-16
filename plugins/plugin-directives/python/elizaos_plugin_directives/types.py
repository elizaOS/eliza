"""Directive types for inline message parsing."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# ============================================================================
# Level type aliases
# ============================================================================

ThinkLevel = Literal["off", "concise", "verbose"]
VerboseLevel = Literal["off", "on"]
ReasoningLevel = Literal["off", "brief", "detailed"]
ElevatedLevel = Literal["off", "on"]

# ============================================================================
# Config dataclasses
# ============================================================================


@dataclass(frozen=True)
class ExecConfig:
    """Execution environment configuration."""

    enabled: bool = False
    auto_approve: bool = False


@dataclass(frozen=True)
class ModelConfig:
    """Model selection configuration."""

    provider: str | None = None
    model: str | None = None
    temperature: float | None = None


# ============================================================================
# Parsed result & state
# ============================================================================


@dataclass(frozen=True)
class ParsedDirectives:
    """All directives parsed from a single message."""

    cleaned_text: str = ""
    directives_only: bool = False

    has_think: bool = False
    think: ThinkLevel | None = None

    has_verbose: bool = False
    verbose: VerboseLevel | None = None

    has_reasoning: bool = False
    reasoning: ReasoningLevel | None = None

    has_elevated: bool = False
    elevated: ElevatedLevel | None = None

    has_exec: bool = False
    exec: ExecConfig | None = None

    has_model: bool = False
    model: ModelConfig | None = None

    has_status: bool = False


@dataclass
class DirectiveState:
    """Full directive state for a session / room."""

    thinking: ThinkLevel = "off"
    verbose: VerboseLevel = "off"
    reasoning: ReasoningLevel = "off"
    elevated: ElevatedLevel = "off"
    exec: ExecConfig = field(default_factory=ExecConfig)
    model: ModelConfig = field(default_factory=ModelConfig)

    def to_dict(self) -> dict[str, object]:
        """Serialize to a plain dictionary."""
        return {
            "thinking": self.thinking,
            "verbose": self.verbose,
            "reasoning": self.reasoning,
            "elevated": self.elevated,
            "exec": {"enabled": self.exec.enabled, "auto_approve": self.exec.auto_approve},
            "model": {
                "provider": self.model.provider,
                "model": self.model.model,
                "temperature": self.model.temperature,
            },
        }
