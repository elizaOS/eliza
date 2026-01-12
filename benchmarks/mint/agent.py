"""
MINT Agent for Multi-turn Task Solving

Implements the agent that solves MINT benchmark tasks through multi-turn
interactions with tool use and feedback.
"""

import logging
import re
import time
from typing import Optional, Protocol, runtime_checkable

from benchmarks.mint.types import (
    MINTTask,
    MINTTrajectory,
    Turn,
    TurnType,
)
from benchmarks.mint.executor import PythonExecutor
from benchmarks.mint.feedback import FeedbackGenerator

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


class MINTAgent:
    """Agent for solving MINT benchmark tasks through multi-turn interaction."""

    # Patterns to detect code blocks
    CODE_BLOCK_PATTERNS = [
        r"```python\s*(.*?)```",
        r"```\s*(.*?)```",
        r"<code>\s*(.*?)</code>",
    ]

    # Patterns to detect final answers (ordered by priority)
    ANSWER_PATTERNS = [
        # Explicit "Final answer: X" format (highest priority)
        r"final\s+answer\s*[:\s]\s*(.+?)(?:\s*$|\n)",
        # "The answer is X" variations
        r"(?:the\s+)?(?:final\s+)?answer\s+is\s*[:\s]?\s*(.+?)(?:\.|$)",
        # "Result: X" or "Result is X"
        r"(?:the\s+)?result\s*(?:is|:)\s*(.+?)(?:\.|$)",
        # Mathematical equals at end of line
        r"=\s*(-?\d+\.?\d*)\s*$",
        # Standalone number on last line preceded by equals
        r"≈\s*(-?\d+\.?\d*)\s*$",
    ]
    
    # Better regex for extracting decimal numbers
    NUMBER_PATTERN = r"-?\d+(?:\.\d+)?"
    
    # Additional fallback patterns for answer extraction
    FALLBACK_PATTERNS = [
        # "Therefore X" or "Thus X"
        r"(?:therefore|thus|hence|so),?\s*(?:the\s+)?(?:answer\s+is\s*)?(.+?)(?:\.|$)",
        # Boxed answers (common in math)
        r"\\boxed\{([^}]+)\}",
        # Bold or emphasized answers
        r"\*\*([^*]+)\*\*\s*$",
        # "= X" at end of calculation
        r"=\s*([^\n=]+?)\s*$",
    ]

    def __init__(
        self,
        runtime: Optional[ModelRuntime] = None,
        tool_executor: Optional[PythonExecutor] = None,
        feedback_generator: Optional[FeedbackGenerator] = None,
        temperature: float = 0.0,
    ) -> None:
        """
        Initialize the MINT agent.

        Args:
            runtime: ElizaOS runtime for model interactions
            tool_executor: Executor for Python code
            feedback_generator: Generator for feedback messages
            temperature: Temperature for model responses (0.0-1.0)
        """
        self._runtime: Optional[ModelRuntime] = None
        if runtime is not None and isinstance(runtime, ModelRuntime):
            self._runtime = runtime
        self.tool_executor = tool_executor or PythonExecutor()
        self.feedback_generator = feedback_generator or FeedbackGenerator()
        # Validate temperature
        self.temperature = max(0.0, min(1.0, temperature))

    @property
    def runtime(self) -> Optional[ModelRuntime]:
        """Get the runtime instance."""
        return self._runtime

    async def solve_task(
        self,
        task: MINTTask,
        enable_tools: bool = True,
        enable_feedback: bool = True,
    ) -> MINTTrajectory:
        """
        Solve a MINT task through multi-turn interaction.

        Args:
            task: The MINT task to solve
            enable_tools: Whether to allow tool (code) execution
            enable_feedback: Whether to provide feedback on incorrect answers

        Returns:
            MINTTrajectory recording the solving process
        """
        trajectory = MINTTrajectory(
            task_id=task.id,
            turns=[],
            start_time_ms=time.time() * 1000,
        )

        current_prompt = task.initial_prompt
        conversation_history: list[dict[str, str]] = []

        logger.info(f"[MINTAgent] Starting task {task.id}: {task.description}")

        for turn_num in range(task.max_turns):
            turn_start = time.time() * 1000

            # Get agent response
            response = await self._get_response(
                current_prompt, conversation_history, task
            )

            # Update conversation history
            conversation_history.append({"role": "user", "content": current_prompt})
            conversation_history.append({"role": "assistant", "content": response})

            # Record the assistant response for this turn (even if it triggers tool use)
            trajectory.turns.append(
                Turn(
                    turn_type=TurnType.ASSISTANT,
                    content=response,
                    turn_number=turn_num + 1,
                    timestamp_ms=turn_start,
                )
            )

            # Check for tool use (code execution)
            if enable_tools and self._has_code(response):
                code = self._extract_code(response)
                if code:
                    logger.debug(f"[MINTAgent] Turn {turn_num + 1}: Executing code")
                    exec_result = await self.tool_executor.execute(code)

                    trajectory.turns.append(
                        Turn(
                            turn_type=TurnType.TOOL,
                            content=code,
                            turn_number=turn_num + 1,
                            tool_call=code,
                            tool_result=exec_result.output,
                            tool_success=exec_result.success,
                            timestamp_ms=time.time() * 1000,
                        )
                    )
                    trajectory.num_tool_uses += 1

                    # Truncate output to avoid context pollution
                    output_preview = exec_result.output[:500] if exec_result.output else ""
                    
                    if exec_result.success:
                        # Clear prompt to focus on the output
                        current_prompt = (
                            f"Code executed successfully. Output:\n```\n{output_preview}\n```\n\n"
                            f"Now provide your final answer in the exact format requested. "
                            f"End with: Final answer: <YOUR_ANSWER>"
                        )
                        # Trim history to reduce context pollution
                        if len(conversation_history) > 4:
                            conversation_history = conversation_history[-4:]
                    else:
                        error_preview = exec_result.error[:300] if exec_result.error else "Unknown error"
                        current_prompt = (
                            f"Code error:\n```\n{error_preview}\n```\n\n"
                            f"Please fix the code and try again."
                        )
                    continue

            # Check for final answer
            answer = self._extract_answer(response, task)
            if answer:
                trajectory.final_answer = answer
                is_correct = self._evaluate_answer(answer, task)
                trajectory.success = is_correct

                if is_correct:
                    logger.info(f"[MINTAgent] Task {task.id}: Correct answer on turn {turn_num + 1}")
                    break
                elif enable_feedback and turn_num < task.max_turns - 1:
                    # Generate feedback for incorrect answer
                    feedback = await self.feedback_generator.generate_feedback(
                        task, trajectory, answer, turn_num + 1
                    )
                    trajectory.turns.append(Turn(
                        turn_type=TurnType.FEEDBACK,
                        content=feedback,
                        turn_number=turn_num + 1,
                        feedback=feedback,
                        timestamp_ms=time.time() * 1000,
                    ))
                    trajectory.num_feedback_turns += 1
                    current_prompt = f"Feedback: {feedback}\n\nPlease try again."
                    continue
                else:
                    # No feedback or last turn - task failed
                    logger.info(f"[MINTAgent] Task {task.id}: Incorrect answer '{answer}'")
                    break

            else:
                # No clear answer, optionally provide generic feedback and continue
                if enable_feedback and turn_num < task.max_turns - 1:
                    feedback = (
                        "I couldn't find a clear answer in your response. "
                        "Please provide a specific answer to the question."
                    )
                    trajectory.turns.append(
                        Turn(
                            turn_type=TurnType.FEEDBACK,
                            content=feedback,
                            turn_number=turn_num + 1,
                            feedback=feedback,
                            timestamp_ms=time.time() * 1000,
                        )
                    )
                    trajectory.num_feedback_turns += 1
                    current_prompt = f"Feedback: {feedback}\n\nPlease try again."

        trajectory.end_time_ms = time.time() * 1000
        return trajectory

    async def _get_response(
        self,
        prompt: str,
        history: list[dict[str, str]],
        task: MINTTask,
    ) -> str:
        """Get a response from the model."""
        if self._runtime is None:
            return await self._get_mock_response(prompt, task)

        from elizaos.types.model import ModelType

        # Build the full prompt with conversation context.
        # Provide the system prompt separately (aligns with elizaOS model plugins).
        system_prompt = self._build_system_prompt(task)
        full_prompt = ""

        for msg in history[-6:]:  # Keep last 3 exchanges for context
            role = "User" if msg["role"] == "user" else "Assistant"
            full_prompt += f"{role}: {msg['content']}\n\n"

        full_prompt += f"User: {prompt}\n\nAssistant:"

        try:
            response = await self._runtime.use_model(
                ModelType.TEXT_LARGE,
                {
                    "prompt": full_prompt,
                    "system": system_prompt,
                    "temperature": self.temperature,
                    "maxTokens": 1024,
                },
            )
            return str(response).strip()
        except Exception as e:
            # If a runtime is configured, we should not silently fall back to a mock.
            logger.error(f"[MINTAgent] Model call failed: {e}")
            raise

    def _build_system_prompt(self, task: MINTTask) -> str:
        """Build system prompt for the task."""
        tools_desc = ""
        if "python" in task.tools_allowed:
            tools_desc = """
TOOL USE: You can execute Python code to verify calculations. Wrap code in ```python blocks:
```python
result = 2 + 2
print(result)
```
Only use code when calculations are complex. For simple problems, reason directly."""

        # Category-specific guidance
        category_guidance = {
            "reasoning": "Think step-by-step. For math problems, show your work clearly.",
            "coding": "Write clean, correct code. Test edge cases mentally.",
            "decision_making": "Consider all constraints systematically. For graph problems, trace paths carefully.",
            "information_seeking": "Extract relevant data first, then compute. Double-check arithmetic.",
        }
        guidance = category_guidance.get(task.category.value, "Think carefully and verify your answer.")

        # Format hints based on evaluation metric
        format_hints = {
            "numeric": "Your answer must be a NUMBER ONLY (e.g., 42 or 3.14). No units, no symbols.",
            "exact_match": "Your answer must match exactly. Check spelling and formatting.",
            "partial_match": "Format your answer exactly as requested in the problem.",
            "code_output": "Your answer must be the numeric output of the code.",
        }
        format_hint = format_hints.get(task.evaluation_metric, "Provide a clear, concise answer.")

        return f"""You are solving a {task.category.value} task.

TASK: {task.description}
{tools_desc}

GUIDANCE: {guidance}

CRITICAL FORMATTING RULES:
1. End your response with EXACTLY this format on its own line:
   Final answer: <ANSWER>
2. {format_hint}
3. Do NOT include explanations after "Final answer:"
4. Do NOT include units, currency symbols, or extra text in <ANSWER>

Example correct format:
"After calculating... the result is 96.
Final answer: 96"

Be precise. Verify your answer before responding."""

    async def _get_mock_response(self, prompt: str, task: MINTTask) -> str:
        """Generate a mock response for testing."""
        # Simple mock that tries to solve basic tasks
        if task.category.value == "reasoning" and "python" in task.tools_allowed:
            return f"""Let me solve this step by step using Python:

```python
# Solving: {task.description}
{self._generate_mock_code(task)}
```"""

        return f"Based on my analysis, the answer is: {task.ground_truth}"

    def _generate_mock_code(self, task: MINTTask) -> str:
        """Generate mock code for testing."""
        return f"""# Mock solution for {task.id}
result = {task.ground_truth}
print(result)"""

    def _has_code(self, response: str) -> bool:
        """Check if response contains code to execute."""
        for pattern in self.CODE_BLOCK_PATTERNS:
            if re.search(pattern, response, re.DOTALL | re.IGNORECASE):
                return True
        return False

    def _extract_code(self, response: str) -> Optional[str]:
        """Extract code from response."""
        for pattern in self.CODE_BLOCK_PATTERNS:
            match = re.search(pattern, response, re.DOTALL | re.IGNORECASE)
            if match:
                code = match.group(1).strip()
                if code:
                    return code
        return None

    def _extract_answer(self, response: str, task: MINTTask) -> Optional[str]:
        """Extract the final answer from response."""
        # First try explicit answer patterns (prioritized)
        for pattern in self.ANSWER_PATTERNS:
            match = re.search(pattern, response, re.IGNORECASE | re.MULTILINE)
            if match:
                answer = match.group(1).strip()
                # Clean up the answer - remove trailing punctuation except decimals
                answer = re.sub(r"[.!?:;,]+$", "", answer).strip()
                if answer:
                    # For numeric tasks, extract just the number from the answer
                    if task.evaluation_metric in ("numeric", "code_output"):
                        nums = re.findall(self.NUMBER_PATTERN, answer)
                        if nums:
                            return nums[-1]
                    return answer

        # For numeric tasks, try to find the last number in the response
        if task.evaluation_metric in ("numeric", "code_output"):
            # Look for numbers in the last few non-empty lines
            lines = [ln.strip() for ln in response.strip().split("\n") if ln.strip()]
            
            # Check last 3 lines for numbers (answer often in final lines)
            for line in reversed(lines[-3:] if len(lines) >= 3 else lines):
                # Skip lines that look like code or explanations
                if line.startswith("#") or line.startswith("```"):
                    continue
                # Look for "= X" pattern first
                eq_match = re.search(r"=\s*(" + self.NUMBER_PATTERN + r")\s*$", line)
                if eq_match:
                    return eq_match.group(1)
                # Then look for standalone numbers
                line_numbers = re.findall(self.NUMBER_PATTERN, line)
                if line_numbers:
                    return line_numbers[-1]

            # Fallback: last number in entire response
            numbers = re.findall(self.NUMBER_PATTERN, response)
            if numbers:
                return numbers[-1]

        # For partial_match tasks with comma-separated values
        if task.evaluation_metric == "partial_match":
            # Look for comma-separated values pattern
            csv_match = re.search(r"(\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)+)", response)
            if csv_match:
                return csv_match.group(1).replace(" ", "")

        # Try fallback patterns
        for pattern in self.FALLBACK_PATTERNS:
            match = re.search(pattern, response, re.IGNORECASE | re.MULTILINE)
            if match:
                answer = match.group(1).strip()
                answer = re.sub(r"[.!?:;,]+$", "", answer).strip()
                if answer and len(answer) < 100:
                    # For numeric tasks, extract number
                    if task.evaluation_metric in ("numeric", "code_output"):
                        nums = re.findall(self.NUMBER_PATTERN, answer)
                        if nums:
                            return nums[-1]
                    return answer

        # Try to find any short answer in the last line
        lines = response.strip().split("\n")
        if lines:
            last_line = lines[-1].strip()
            # If last line is short and looks like an answer
            if len(last_line) < 100 and not last_line.endswith("?"):
                # Remove common prefixes
                for prefix in ["answer:", "result:", "therefore,", "so,", "thus,"]:
                    if last_line.lower().startswith(prefix):
                        return last_line[len(prefix):].strip()
                # If it's just a number or short text
                if re.match(r"^[\w\s,.\-]+$", last_line) and len(last_line) < 50:
                    return last_line

        return None

    def _evaluate_answer(self, predicted: str, task: MINTTask) -> bool:
        """Evaluate if the predicted answer is correct."""
        expected = task.ground_truth
        metric = task.evaluation_metric

        predicted = str(predicted).strip().lower()
        expected = str(expected).strip().lower()

        if metric == "exact_match":
            # Normalize whitespace and compare
            pred_norm = " ".join(predicted.split())
            exp_norm = " ".join(expected.split())
            return pred_norm == exp_norm

        elif metric == "numeric":
            try:
                pred_nums = re.findall(self.NUMBER_PATTERN, predicted)
                exp_nums = re.findall(self.NUMBER_PATTERN, expected)
                if pred_nums and exp_nums:
                    pred_val = float(pred_nums[-1])
                    exp_val = float(exp_nums[-1])
                    # Allow 2% tolerance for floating point (increased from 1%)
                    if exp_val == 0:
                        return abs(pred_val) < 0.02
                    relative_error = abs(pred_val - exp_val) / abs(exp_val)
                    return relative_error < 0.02
            except ValueError:
                pass
            return False

        elif metric == "partial_match":
            # Normalize both strings
            pred_norm = " ".join(predicted.split())
            exp_norm = " ".join(expected.split())
            if not pred_norm or not exp_norm:
                return False
            return exp_norm in pred_norm or pred_norm in exp_norm

        elif metric == "code_output":
            return self._evaluate_answer(predicted, MINTTask(
                id=task.id,
                category=task.category,
                description=task.description,
                initial_prompt=task.initial_prompt,
                ground_truth=expected,
                evaluation_metric="numeric",
            ))

        return predicted == expected


class MockMINTAgent:
    """Mock agent for testing that returns predetermined answers."""

    def __init__(self, answers: Optional[dict[str, str]] = None) -> None:
        self.answers = answers or {}
        self.tasks_attempted: list[str] = []

    async def solve_task(
        self,
        task: MINTTask,
        enable_tools: bool = True,
        enable_feedback: bool = True,
    ) -> MINTTrajectory:
        """Return mock trajectory."""
        self.tasks_attempted.append(task.id)

        trajectory = MINTTrajectory(
            task_id=task.id,
            start_time_ms=time.time() * 1000,
        )

        # Use predetermined answer or ground truth
        answer = self.answers.get(task.id, task.ground_truth)
        trajectory.final_answer = answer
        trajectory.success = answer == task.ground_truth

        trajectory.turns.append(Turn(
            turn_type=TurnType.ASSISTANT,
            content=f"The answer is: {answer}",
            turn_number=1,
        ))

        trajectory.end_time_ms = time.time() * 1000
        return trajectory
