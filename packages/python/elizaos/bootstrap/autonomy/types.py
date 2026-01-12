from __future__ import annotations

from dataclasses import dataclass


@dataclass
class AutonomyStatus:
    enabled: bool
    running: bool
    thinking: bool
    interval: int
    autonomous_room_id: str


@dataclass
class AutonomyConfig:
    interval_ms: int = 30000
    auto_start: bool = False
