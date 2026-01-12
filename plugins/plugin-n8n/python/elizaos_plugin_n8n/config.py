from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from elizaos_plugin_n8n.errors import ApiKeyError
from elizaos_plugin_n8n.models import ClaudeModel


@dataclass
class N8nConfig:
    api_key: str
    model: ClaudeModel = field(default_factory=ClaudeModel.default)
    data_dir: Path = field(default_factory=lambda: Path.cwd() / "data")
    max_iterations: int = 5
    max_concurrent_jobs: int = 10
    job_timeout_seconds: int = 30 * 60
    rate_limit_per_hour: int = 10

    @classmethod
    def from_env(cls) -> N8nConfig:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ApiKeyError("ANTHROPIC")

        model_str = os.environ.get("CLAUDE_MODEL")
        model = ClaudeModel.default()
        if model_str:
            try:
                model = ClaudeModel(model_str)
            except ValueError:
                pass

        data_dir = os.environ.get("PLUGIN_DATA_DIR")
        data_path = Path(data_dir) if data_dir else Path.cwd() / "data"

        return cls(
            api_key=api_key,
            model=model,
            data_dir=data_path,
        )

    def get_plugins_dir(self) -> Path:
        plugins_dir = self.data_dir / "plugins"
        plugins_dir.mkdir(parents=True, exist_ok=True)
        return plugins_dir

    def validate(self) -> None:
        if not self.api_key:
            raise ApiKeyError("ANTHROPIC")
