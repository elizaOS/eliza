"""
Reasoning Gym environment implementation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos_atropos_reasoning.types import (
    TaskType,
    Difficulty,
    Problem,
    Response,
    StepResult,
    EpisodeResult,
)
from elizaos_atropos_reasoning.problems.math import MathProblemGenerator
from elizaos_atropos_reasoning.problems.logic import LogicProblemGenerator
from elizaos_atropos_reasoning.problems.puzzles import PuzzleProblemGenerator
from elizaos_atropos_reasoning.evaluator import evaluate_answer, extract_answer_from_text

if TYPE_CHECKING:
    pass


class ReasoningEnvironment:
    """
    Reasoning Gym environment for training reasoning capabilities.
    
    Provides structured reasoning tasks across multiple domains
    (math, logic, puzzles) with varying difficulty levels.
    
    Example:
        >>> env = ReasoningEnvironment(task_type=TaskType.MATH)
        >>> await env.initialize()
        >>> state = await env.reset()
        >>> result = await env.step(Response(answer="42"))
    """

    def __init__(
        self,
        task_type: TaskType | str = TaskType.MATH,
        difficulty: Difficulty | str = Difficulty.MEDIUM,
        max_attempts: int = 3,
        seed: int | None = None,
    ) -> None:
        """
        Initialize the environment.
        
        Args:
            task_type: Type of reasoning tasks
            difficulty: Problem difficulty
            max_attempts: Maximum attempts per problem
            seed: Random seed
        """
        if isinstance(task_type, str):
            task_type = TaskType(task_type)
        if isinstance(difficulty, str):
            difficulty = Difficulty(difficulty)

        self._task_type = task_type
        self._difficulty = difficulty
        self._max_attempts = max_attempts
        self._seed = seed

        # Generators
        self._math_gen = MathProblemGenerator(seed)
        self._logic_gen = LogicProblemGenerator(seed)
        self._puzzle_gen = PuzzleProblemGenerator(seed)

        # State
        self._current_problem: Problem | None = None
        self._attempts: int = 0
        self._hints_used: int = 0
        self._reasoning_steps: list[str] = []
        self._initialized = False

    @property
    def task_type(self) -> TaskType:
        """Get current task type."""
        return self._task_type

    @property
    def difficulty(self) -> Difficulty:
        """Get current difficulty."""
        return self._difficulty

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> StepResult:
        """
        Reset with a new problem.
        
        Args:
            seed: Optional random seed
            
        Returns:
            Initial step result with the problem
        """
        if seed is not None:
            self._math_gen = MathProblemGenerator(seed)
            self._logic_gen = LogicProblemGenerator(seed)
            self._puzzle_gen = PuzzleProblemGenerator(seed)

        # Generate problem based on task type
        if self._task_type == TaskType.MATH:
            self._current_problem = self._math_gen.generate(self._difficulty)
        elif self._task_type == TaskType.LOGIC:
            self._current_problem = self._logic_gen.generate(self._difficulty)
        elif self._task_type == TaskType.PUZZLE:
            self._current_problem = self._puzzle_gen.generate(self._difficulty)
        elif self._task_type == TaskType.MIXED:
            import random
            gen = random.choice([self._math_gen, self._logic_gen, self._puzzle_gen])
            self._current_problem = gen.generate(self._difficulty)
        else:
            self._current_problem = self._math_gen.generate(self._difficulty)

        self._attempts = 0
        self._hints_used = 0
        self._reasoning_steps = []

        return StepResult(
            problem=self._current_problem,
            response=None,
            is_correct=False,
            feedback=f"Solve this problem:\n\n{self._current_problem.question}",
            score=0.0,
            done=False,
        )

    async def step(self, response: Response | str) -> StepResult:
        """
        Submit a response to the current problem.
        
        Args:
            response: The response (can be Response object or answer string)
            
        Returns:
            Step result with feedback
        """
        if self._current_problem is None:
            return StepResult(
                problem=Problem(
                    id="none",
                    task_type=self._task_type,
                    difficulty=self._difficulty,
                    question="No problem loaded",
                    expected_answer="",
                ),
                response=None,
                is_correct=False,
                feedback="No problem loaded. Call reset() first.",
                score=0.0,
                done=True,
            )

        # Convert string to Response
        if isinstance(response, str):
            answer = extract_answer_from_text(response)
            response = Response(answer=answer, reasoning=response)

        self._attempts += 1

        # Store reasoning steps
        if response.reasoning:
            self._reasoning_steps.append(response.reasoning)
        if response.steps:
            self._reasoning_steps.extend(response.steps)

        # Evaluate answer
        is_correct, feedback = evaluate_answer(
            response.answer,
            self._current_problem.expected_answer,
            self._current_problem,
        )

        # Calculate score
        if is_correct:
            # Base score, penalized for attempts and hints
            score = 1.0 - 0.1 * (self._attempts - 1) - 0.05 * self._hints_used
            score = max(0.1, score)
        else:
            score = 0.0

        # Check if done
        done = is_correct or self._attempts >= self._max_attempts

        # Provide hint if wrong and attempts remaining
        if not is_correct and self._attempts < self._max_attempts:
            if self._current_problem.hints and self._hints_used < len(self._current_problem.hints):
                hint = self._current_problem.hints[self._hints_used]
                feedback += f"\n\nHint: {hint}"
                self._hints_used += 1

        # Show explanation if done and wrong
        if done and not is_correct and self._current_problem.explanation:
            feedback += f"\n\nExplanation: {self._current_problem.explanation}"

        return StepResult(
            problem=self._current_problem,
            response=response,
            is_correct=is_correct,
            feedback=feedback,
            score=score,
            done=done,
            hints_used=self._hints_used,
            attempts=self._attempts,
        )

    def get_hint(self) -> str | None:
        """
        Get the next available hint.
        
        Returns:
            Hint string or None if no hints available
        """
        if self._current_problem is None:
            return None

        if self._hints_used < len(self._current_problem.hints):
            hint = self._current_problem.hints[self._hints_used]
            self._hints_used += 1
            return hint

        return None

    def get_episode_result(self) -> EpisodeResult:
        """Get result of the current episode."""
        if self._current_problem is None:
            raise RuntimeError("No problem loaded")

        # Determine if correct based on last evaluation
        is_correct = False
        final_answer = None

        if self._reasoning_steps:
            final_answer = extract_answer_from_text(self._reasoning_steps[-1])
            is_correct, _ = evaluate_answer(
                final_answer,
                self._current_problem.expected_answer,
                self._current_problem,
            )

        return EpisodeResult(
            problem=self._current_problem,
            final_answer=final_answer,
            is_correct=is_correct,
            attempts=self._attempts,
            hints_used=self._hints_used,
            reasoning_steps=list(self._reasoning_steps),
            score=1.0 if is_correct else 0.0,
        )

    async def close(self) -> None:
        """Close the environment."""
        self._current_problem = None
        self._initialized = False
