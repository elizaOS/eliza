"""
Configuration for the N8n Plugin.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from elizaos_plugin_n8n.errors import ApiKeyError
from elizaos_plugin_n8n.models import ClaudeModel


@dataclass
class N8nConfig:
    """Configuration for the N8n plugin creation service."""

    api_key: str
    model: ClaudeModel = field(default_factory=ClaudeModel.default)
    data_dir: Path = field(default_factory=lambda: Path.cwd() / "data")
    max_iterations: int = 5
    max_concurrent_jobs: int = 10
    job_timeout_seconds: int = 30 * 60  # 30 minutes
    rate_limit_per_hour: int = 10

    @classmethod
    def from_env(cls) -> "N8nConfig":
        """
        Create configuration from environment variables.

        Environment variables:
        - ANTHROPIC_API_KEY: Required. API key for Anthropic.
        - CLAUDE_MODEL: Optional. Model to use (default: claude-3-opus-20240229).
        - PLUGIN_DATA_DIR: Optional. Directory for plugin workspace (default: ./data).

        Returns:
            N8nConfig instance.

        Raises:
            ApiKeyError: If ANTHROPIC_API_KEY is not set.
        """
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ApiKeyError("ANTHROPIC")

        model_str = os.environ.get("CLAUDE_MODEL")
        model = ClaudeModel.default()
        if model_str:
            try:
                model = ClaudeModel(model_str)
            except ValueError:
                pass  # Use default if invalid

        data_dir = os.environ.get("PLUGIN_DATA_DIR")
        data_path = Path(data_dir) if data_dir else Path.cwd() / "data"

        return cls(
            api_key=api_key,
            model=model,
            data_dir=data_path,
        )

    def get_plugins_dir(self) -> Path:
        """Get the directory for storing generated plugins."""
        plugins_dir = self.data_dir / "plugins"
        plugins_dir.mkdir(parents=True, exist_ok=True)
        return plugins_dir

    def validate(self) -> None:
        """
        Validate the configuration.

        Raises:
            ApiKeyError: If API key is missing.
        """
        if not self.api_key:
            raise ApiKeyError("ANTHROPIC")

