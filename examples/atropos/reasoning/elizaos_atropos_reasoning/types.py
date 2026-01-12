"""
Type definitions for the Reasoning Gym environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TypeAlias


class TaskType(str, Enum):
    """Types of reasoning tasks."""

    MATH = "math"
    LOGIC = "logic"
    PUZZLE = "puzzle"
    COMMONSENSE = "commonsense"
    MIXED = "mixed"


class Difficulty(str, Enum):
    """Problem difficulty levels."""

    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


# Type aliases
Answer: TypeAlias = str | int | float | bool | list[str]


@dataclass
class Problem:
    """A reasoning problem."""

    id: str
    task_type: TaskType
    difficulty: Difficulty
    question: str
    expected_answer: Answer
    explanation: str | None = None
    hints: list[str] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"[{self.task_type.value}/{self.difficulty.value}] {self.question}"


@dataclass
class Response:
    """A response to a problem."""

    answer: Answer
    reasoning: str | None = None
    confidence: float = 1.0
    steps: list[str] = field(default_factory=list)

    def __str__(self) -> str:
        if self.reasoning:
            return f"Answer: {self.answer}\nReasoning: {self.reasoning}"
        return f"Answer: {self.answer}"


@dataclass
class StepResult:
    """Result of a reasoning step."""

    problem: Problem
    response: Response | None
    is_correct: bool
    feedback: str
    score: float
    done: bool
    hints_used: int = 0
    attempts: int = 0


@dataclass
class EpisodeResult:
    """Result of solving a problem."""

    problem: Problem
    final_answer: Answer | None
    is_correct: bool
    attempts: int
    hints_used: int
    reasoning_steps: list[str]
    score: float

    @property
    def efficiency(self) -> float:
        """Calculate efficiency (fewer attempts = higher)."""
        if self.attempts == 0:
            return 0.0
        base_score = 1.0 if self.is_correct else 0.0
        penalty = 0.1 * (self.attempts - 1) + 0.05 * self.hints_used
        return max(0.0, base_score - penalty)


@dataclass
class BenchmarkResult:
    """Result of running a benchmark."""

    task_type: TaskType
    difficulty: Difficulty
    total_problems: int
    correct: int
    total_attempts: int
    total_hints: int

    @property
    def accuracy(self) -> float:
        """Calculate accuracy."""
        if self.total_problems == 0:
            return 0.0
        return self.correct / self.total_problems

    @property
    def avg_attempts(self) -> float:
        """Average attempts per problem."""
        if self.total_problems == 0:
            return 0.0
        return self.total_attempts / self.total_problems

    @property
    def avg_hints(self) -> float:
        """Average hints per problem."""
        if self.total_problems == 0:
            return 0.0
        return self.total_hints / self.total_problems

    def __str__(self) -> str:
        return (
            f"{self.task_type.value}/{self.difficulty.value}: "
            f"{self.accuracy:.1%} accuracy "
            f"({self.correct}/{self.total_problems}), "
            f"avg {self.avg_attempts:.1f} attempts"
        )


@dataclass
class TrainingStats:
    """Statistics for training sessions."""

    problems_attempted: int = 0
    problems_correct: int = 0
    total_attempts: int = 0
    total_hints: int = 0
    by_type: dict[TaskType, BenchmarkResult] = field(default_factory=dict)

    @property
    def accuracy(self) -> float:
        """Overall accuracy."""
        if self.problems_attempted == 0:
            return 0.0
        return self.problems_correct / self.problems_attempted

    def record_episode(self, result: EpisodeResult) -> None:
        """Record an episode result."""
        self.problems_attempted += 1
        self.total_attempts += result.attempts
        self.total_hints += result.hints_used

        if result.is_correct:
            self.problems_correct += 1

    def __str__(self) -> str:
        return (
            f"Problems: {self.problems_attempted} | "
            f"Accuracy: {self.accuracy:.1%} | "
            f"Avg Attempts: {self.total_attempts / max(1, self.problems_attempted):.1f}"
        )
