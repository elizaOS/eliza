"""LifeWorld package — stateful in-memory database of the user's life surface.

Public exports:
    LifeWorld          — the world class (entities + helpers + snapshot/serialize).
    WorldGenerator     — seeded fixture builder.
    WorldSnapshot      — frozen dict-of-dicts state copy.
    EntityKind         — enum of every storable entity kind.
    world_state_hash   — convenience wrapper around `world.state_hash()`.
"""

from __future__ import annotations

from .entities import EntityKind
from .generators import WorldGenerator
from .world import LifeWorld, WorldSnapshot


def world_state_hash(world: LifeWorld) -> str:
    """Convenience pass-through used by the scorer module."""
    return world.state_hash()


__all__ = [
    "EntityKind",
    "LifeWorld",
    "WorldGenerator",
    "WorldSnapshot",
    "world_state_hash",
]
