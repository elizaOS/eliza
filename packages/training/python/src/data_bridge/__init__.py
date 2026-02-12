"""Data bridge for converting trajectories to Atropos format."""

from .reader import PostgresTrajectoryReader
from .converter import (
    TrajectoryToAtroposConverter,
    BabylonToAtroposConverter,
    AtroposMessage,
    AtroposTrajectory,
    ScoredGroupResult,
    calculate_dropout_rate,
)
# Re-export Pydantic model from models for API compatibility
from ..models import AtroposScoredGroup

__all__ = [
    "PostgresTrajectoryReader",
    "TrajectoryToAtroposConverter",
    "BabylonToAtroposConverter",
    "AtroposMessage",
    "AtroposTrajectory", 
    "ScoredGroupResult",
    "AtroposScoredGroup",  # Pydantic model from models.py
    "calculate_dropout_rate",
]
