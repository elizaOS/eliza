from .reflection import reflection_evaluator
from .relationship_extraction import relationship_extraction_evaluator

__all__ = [
    "reflection_evaluator",
    "relationship_extraction_evaluator",
    "BASIC_EVALUATORS",
    "EXTENDED_EVALUATORS",
    "ALL_EVALUATORS",
]

BASIC_EVALUATORS: list = []

EXTENDED_EVALUATORS = [
    reflection_evaluator,
    relationship_extraction_evaluator,
]

ALL_EVALUATORS = BASIC_EVALUATORS + EXTENDED_EVALUATORS
