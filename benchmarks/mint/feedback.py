"""
Feedback Generator for MINT Benchmark

Generates natural language feedback for agent responses in multi-turn interactions.
Simulates user feedback as described in the MINT paper.
"""

import logging
import re
from typing import Optional, Protocol, runtime_checkable

from benchmarks.mint.types import MINTTask, MINTTrajectory

logger = logging.getLogger(__name__)


@runtime_checkable
class ModelRuntime(Protocol):
    """Protocol for model runtime that can generate text."""

    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> object:
        """Use a model to generate text."""
        ...


class FeedbackGenerator:
    """Generate natural language feedback for agent responses."""

    def __init__(
        self,
        runtime: Optional[ModelRuntime] = None,
        use_llm: bool = False,
        feedback_model: str = "gpt-4",
    ) -> None:
        """
        Initialize the feedback generator.

        Args:
            runtime: Optional ElizaOS runtime for LLM-based feedback
            use_llm: Whether to use LLM for feedback generation
            feedback_model: Model to use for feedback generation
        """
        self._runtime: Optional[ModelRuntime] = None
        if runtime is not None and isinstance(runtime, ModelRuntime):
            self._runtime = runtime
        self.use_llm = use_llm and self._runtime is not None
        self.feedback_model = feedback_model

    @property
    def runtime(self) -> Optional[ModelRuntime]:
        """Get the runtime instance."""
        return self._runtime

    async def generate(
        self,
        task: MINTTask,
        predicted: str,
        turn_num: int,
    ) -> str:
        """
        Generate feedback for incorrect answer (simplified interface).

        Args:
            task: The MINT task being solved
            predicted: The agent's predicted answer
            turn_num: Current turn number

        Returns:
            Feedback string to guide the agent
        """
        # Create a minimal trajectory for the feedback generator
        from benchmarks.mint.types import MINTTrajectory
        trajectory = MINTTrajectory(task_id=task.id)
        trajectory.final_answer = predicted

        return await self.generate_feedback(
            task=task,
            trajectory=trajectory,
            current_answer=predicted,
            current_turn=turn_num,
        )

    async def generate_feedback(
        self,
        task: MINTTask,
        trajectory: MINTTrajectory,
        current_answer: str,
        current_turn: int,
    ) -> str:
        """
        Generate feedback for the current agent response.

        Args:
            task: The MINT task being solved
            trajectory: Current trajectory of the interaction
            current_answer: The agent's current answer
            current_turn: Current turn number

        Returns:
            Feedback string to guide the agent
        """
        # First check if the answer is correct
        is_correct = self._check_answer(current_answer, task.ground_truth, task.evaluation_metric)

        if is_correct:
            return "Your answer is correct! Well done."

        # Generate appropriate feedback based on the situation
        if self.use_llm:
            return await self._generate_llm_feedback(task, trajectory, current_answer)
        else:
            return self._generate_rule_based_feedback(
                task, trajectory, current_answer, current_turn
            )

    def _check_answer(
        self,
        predicted: str,
        expected: str,
        metric: str = "exact_match",
    ) -> bool:
        """Check if the predicted answer matches the expected answer."""
        if not predicted or not expected:
            return False

        predicted = str(predicted).strip().lower()
        expected = str(expected).strip().lower()

        if metric == "exact_match":
            return predicted == expected

        elif metric == "numeric":
            return self._numeric_match(predicted, expected)

        elif metric == "partial_match":
            # Check if either contains the other
            return expected in predicted or predicted in expected

        elif metric == "code_output":
            # Compare numeric outputs
            return self._numeric_match(predicted, expected)

        return predicted == expected

    def _numeric_match(self, predicted: str, expected: str, tolerance: float = 0.01) -> bool:
        """Compare numeric values with tolerance."""
        try:
            # Extract numeric values
            pred_nums = re.findall(r"-?\d+\.?\d*", predicted)
            exp_nums = re.findall(r"-?\d+\.?\d*", expected)

            if not pred_nums or not exp_nums:
                return False

            pred_val = float(pred_nums[-1])  # Use last number found
            exp_val = float(exp_nums[-1])

            # Check with relative tolerance
            if exp_val == 0:
                return abs(pred_val) < tolerance
            return abs(pred_val - exp_val) / abs(exp_val) < tolerance

        except (ValueError, IndexError):
            return False

    def _generate_rule_based_feedback(
        self,
        task: MINTTask,
        trajectory: MINTTrajectory,
        current_answer: str,
        current_turn: int,
    ) -> str:
        """Generate feedback using rule-based approach."""
        feedback_parts: list[str] = []

        # Check if answer is close
        closeness = self._assess_answer_closeness(current_answer, task.ground_truth)

        if closeness == "empty":
            feedback_parts.append("I don't see a clear answer in your response.")
            feedback_parts.append("Please provide a specific answer to the question.")

        elif closeness == "wrong_format":
            feedback_parts.append("Your answer doesn't seem to be in the expected format.")
            if task.evaluation_metric == "numeric":
                feedback_parts.append("Please provide a numerical answer.")
            feedback_parts.append("Try to format your answer more clearly.")

        elif closeness == "close":
            feedback_parts.append("You're on the right track, but your answer isn't quite correct.")
            feedback_parts.append("Double-check your calculations or reasoning.")

        else:  # far
            feedback_parts.append("Your answer doesn't appear to be correct.")

            # Provide category-specific hints
            if task.category.value == "reasoning":
                feedback_parts.append("Make sure to break down the problem step by step.")
                if "python" in task.tools_allowed:
                    feedback_parts.append(
                        "Consider using Python to verify your calculations."
                    )

            elif task.category.value == "coding":
                if trajectory.num_tool_uses == 0:
                    feedback_parts.append("Try writing and executing code to solve this problem.")
                else:
                    feedback_parts.append(
                        "Review your code for errors and try again."
                    )

            elif task.category.value == "decision_making":
                feedback_parts.append(
                    "Think carefully about all the options and their outcomes."
                )

            elif task.category.value == "information_seeking":
                feedback_parts.append(
                    "Make sure you're extracting the right information from the data."
                )

        # Add encouragement based on turn number
        if current_turn < task.max_turns - 1:
            remaining = task.max_turns - current_turn - 1
            feedback_parts.append(
                f"You have {remaining} more {'turn' if remaining == 1 else 'turns'} to try."
            )

        return " ".join(feedback_parts)

    def _assess_answer_closeness(self, predicted: str, expected: str) -> str:
        """Assess how close the predicted answer is to expected."""
        if not predicted or not predicted.strip():
            return "empty"

        predicted = str(predicted).strip()
        expected = str(expected).strip()

        # Check for numeric answers
        try:
            pred_nums = re.findall(r"-?\d+\.?\d*", predicted)
            exp_nums = re.findall(r"-?\d+\.?\d*", expected)

            if exp_nums and not pred_nums:
                return "wrong_format"

            if pred_nums and exp_nums:
                pred_val = float(pred_nums[-1])
                exp_val = float(exp_nums[-1])

                # Check if within 20% of expected
                if exp_val != 0:
                    error_ratio = abs(pred_val - exp_val) / abs(exp_val)
                    if error_ratio < 0.2:
                        return "close"
                elif abs(pred_val) < 1:
                    return "close"

        except (ValueError, IndexError):
            pass

        # Check for string similarity
        if expected.lower() in predicted.lower() or predicted.lower() in expected.lower():
            return "close"

        return "far"

    async def _generate_llm_feedback(
        self,
        task: MINTTask,
        trajectory: MINTTrajectory,
        current_answer: str,
    ) -> str:
        """Generate feedback using LLM."""
        if self._runtime is None:
            return self._generate_rule_based_feedback(
                task, trajectory, current_answer, len(trajectory.turns)
            )

        feedback_prompt = f"""You are evaluating an AI assistant's response to a task.

Task: {task.description}
Question: {task.initial_prompt}
Expected answer: {task.ground_truth}
Assistant's answer: {current_answer}

The assistant's answer is NOT correct. Generate helpful feedback to guide them toward the correct answer.

Guidelines:
- Do NOT reveal the correct answer directly
- Point out what might be wrong with their approach
- Suggest a direction or strategy they could try
- Be encouraging but clear that their answer is incorrect
- Keep feedback concise (2-3 sentences)

Feedback:"""

        try:
            # Use runtime's model for feedback generation
            from elizaos.types.model import ModelType

            response = await self._runtime.use_model(
                ModelType.TEXT_LARGE,
                {"prompt": feedback_prompt, "temperature": 0.3, "maxTokens": 150},
            )
            return str(response).strip()
        except Exception as e:
            logger.warning(f"[FeedbackGenerator] LLM feedback failed: {e}, using rules")
            return self._generate_rule_based_feedback(
                task, trajectory, current_answer, len(trajectory.turns)
            )


class MockFeedbackGenerator:
    """Mock feedback generator for testing."""

    def __init__(self) -> None:
        self.feedback_history: list[tuple[str, str]] = []

    async def generate_feedback(
        self,
        task: MINTTask,
        trajectory: MINTTrajectory,
        current_answer: str,
        current_turn: int,
    ) -> str:
        """Return mock feedback."""
        feedback = f"Turn {current_turn}: Your answer '{current_answer}' is not correct. Please try again."
        self.feedback_history.append((current_answer, feedback))
        return feedback
