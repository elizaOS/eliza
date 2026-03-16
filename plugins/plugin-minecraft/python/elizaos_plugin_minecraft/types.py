from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MinecraftConfig:
    server_port: int = 3457
