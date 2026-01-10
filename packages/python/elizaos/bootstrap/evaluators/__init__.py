"""
Evaluators for the elizaOS Bootstrap Plugin.

This module exports all available evaluators for the bootstrap plugin.
"""

from .reflection import reflection_evaluator
from .relationship_extraction import relationship_extraction_evaluator

__all__ = [
    "reflection_evaluator",
    "relationship_extraction_evaluator",
    # Capability lists
    "BASIC_EVALUATORS",
    "EXTENDED_EVALUATORS",
    "ALL_EVALUATORS",
]

# Basic evaluators - included by default
BASIC_EVALUATORS: list = []

# Extended evaluators - opt-in
EXTENDED_EVALUATORS = [
    reflection_evaluator,
    relationship_extraction_evaluator,
]

# All evaluators list for easy registration (backwards compatibility)
ALL_EVALUATORS = BASIC_EVALUATORS + EXTENDED_EVALUATORS
