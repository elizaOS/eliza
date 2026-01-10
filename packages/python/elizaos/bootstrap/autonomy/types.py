"""
Autonomy Types for elizaOS - Python implementation.

Defines types for autonomous agent operation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.types.primitives import UUID


@dataclass
class AutonomyStatus:
    """Status information for the autonomy service."""
    
    enabled: bool
    """Whether autonomy is enabled in settings."""
    
    running: bool
    """Whether the autonomy loop is currently running."""
    
    thinking: bool
    """Whether an autonomous think cycle is currently in progress."""
    
    interval: int
    """Interval between autonomous thoughts in milliseconds."""
    
    autonomous_room_id: str
    """ID of the dedicated autonomous room."""


@dataclass
class AutonomyConfig:
    """Configuration for autonomous operation."""
    
    interval_ms: int = 30000
    """Interval between autonomous thoughts in milliseconds (default: 30000)."""
    
    auto_start: bool = False
    """Auto-start autonomy when enabled in settings."""

