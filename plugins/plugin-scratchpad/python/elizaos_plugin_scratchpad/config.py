"""Configuration for the Scratchpad Plugin."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from elizaos_plugin_scratchpad.error import ConfigError


@dataclass
class ScratchpadConfig:
    """Configuration for the scratchpad service."""

    base_path: str = field(
        default_factory=lambda: str(Path.home() / ".eliza" / "scratchpad")
    )
    max_file_size: int = 1024 * 1024  # 1MB
    allowed_extensions: list[str] = field(default_factory=lambda: [".md", ".txt"])

    @classmethod
    def from_env(cls) -> "ScratchpadConfig":
        """Create configuration from environment variables."""
        base_path = os.getenv(
            "SCRATCHPAD_BASE_PATH",
            str(Path.home() / ".eliza" / "scratchpad"),
        )
        max_file_size = int(os.getenv("SCRATCHPAD_MAX_FILE_SIZE", str(1024 * 1024)))
        extensions_str = os.getenv("SCRATCHPAD_ALLOWED_EXTENSIONS", ".md,.txt")
        allowed_extensions = [ext.strip() for ext in extensions_str.split(",")]

        return cls(
            base_path=base_path,
            max_file_size=max_file_size,
            allowed_extensions=allowed_extensions,
        )

    def validate(self) -> None:
        """Validate the configuration.

        Raises:
            ConfigError: If configuration is invalid.
        """
        if self.max_file_size < 1024:
            raise ConfigError("max_file_size must be at least 1024 bytes")

        if not self.allowed_extensions:
            raise ConfigError("allowed_extensions must not be empty")

        for ext in self.allowed_extensions:
            if not ext.startswith("."):
                raise ConfigError(f"Extension must start with '.': {ext}")
