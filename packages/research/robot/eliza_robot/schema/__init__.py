"""Shared schema helpers for AiNex training and deployment."""

from eliza_robot.schema.canonical import (
    AINEX_ACTION_DIM,
    AINEX_ENTITY_SLOT_DIM,
    AINEX_PROPRIO_DIM,
    AINEX_SCHEMA_VERSION,
    AINEX_STATE_DIM,
)
from eliza_robot.schema.embodied_context import ContextEntity, EmbodiedContext

__all__ = [
    "AINEX_ACTION_DIM",
    "AINEX_ENTITY_SLOT_DIM",
    "AINEX_PROPRIO_DIM",
    "AINEX_SCHEMA_VERSION",
    "AINEX_STATE_DIM",
    "ContextEntity",
    "EmbodiedContext",
]
