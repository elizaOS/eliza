from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ComputerUseMode(str, Enum):
    AUTO = "auto"
    LOCAL = "local"
    MCP = "mcp"


@dataclass
class ComputerUseConfig:
    enabled: bool = False
    mode: ComputerUseMode = ComputerUseMode.AUTO
    mcp_command: str = "npx"
    mcp_args: list[str] = field(default_factory=lambda: ["-y", "computeruse-mcp-agent@latest"])
