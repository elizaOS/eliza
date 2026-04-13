"""
ElizaOS Atropos Reasoning Gym Environment

A reasoning and problem-solving environment for training ElizaOS agents.
"""

from elizaos_atropos_reasoning.types import (
    TaskType,
    Difficulty,
    Problem,
    Response,
    StepResult,
    EpisodeResult,
    BenchmarkResult,
)
from elizaos_atropos_reasoning.environment import ReasoningEnvironment
from elizaos_atropos_reasoning.agent import ReasoningAgent
from elizaos_atropos_reasoning.evaluator import evaluate_answer, normalize_answer

__version__ = "1.0.0"

__all__ = [
    # Types
    "TaskType",
    "Difficulty",
    "Problem",
    "Response",
    "StepResult",
    "EpisodeResult",
    "BenchmarkResult",
    # Environment
    "ReasoningEnvironment",
    # Agent
    "ReasoningAgent",
    # Evaluator
    "evaluate_answer",
    "normalize_answer",
]
