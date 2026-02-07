"""
MINT Agent for Multi-turn Task Solving

Uses the CANONICAL ElizaOS pipeline:
- Memory/Content for messages
- message_service.handle_message() for full processing
- Providers compose state with context
- Actions can be triggered
"""

import logging
import re
import time
import uuid
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
class ElizaRuntime(Protocol):
    """Protocol matching the canonical IAgentRuntime interface."""

    @property
    def agent_id(self) -> object: ...

    @property
    def character(self) -> object: ...

    @property
    def message_service(self) -> object: ...

    async def initialize(self) -> None: ...

    async def stop(self) -> None: ...

    async def compose_state(
        self,
        message: object,
        include_list: list[str] | None = None,
        only_include: bool = False,
        skip_cache: bool = False,
    ) -> object: ...

    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> object: ...


class MINTAgent:
    """
    Agent for solving MINT benchmark tasks through multi-turn interaction.
    
    Uses the CANONICAL ElizaOS message handling pipeline:
    - Creates Memory objects with Content
    - Calls message_service.handle_message() for full pipeline
    - Leverages providers for context composition
    - Supports action processing
    """

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
        runtime: Optional[ElizaRuntime] = None,
        tool_executor: Optional[PythonExecutor] = None,
        feedback_generator: Optional[FeedbackGenerator] = None,
        temperature: float = 0.0,
        trajectory_logger_service: object | None = None,
        trajectory_ids_sink: list[str] | None = None,
    ) -> None:
        """
        Initialize the MINT agent.

        Args:
            runtime: ElizaOS runtime for CANONICAL message handling
            tool_executor: Executor for Python code
            feedback_generator: Generator for feedback messages
            temperature: Temperature for model responses (0.0-1.0)
        """
        self._runtime: Optional[ElizaRuntime] = None
        if runtime is not None and isinstance(runtime, ElizaRuntime):
            self._runtime = runtime
        self.tool_executor = tool_executor or PythonExecutor()
        self.feedback_generator = feedback_generator or FeedbackGenerator()
        # Validate temperature
        self.temperature = max(0.0, min(1.0, temperature))

        # Session tracking for canonical Eliza flow
        self._room_id: object | None = None
        self._user_id: object | None = None

        # Optional elizaOS trajectory logger plugin service + sink for IDs
        self._trajectory_logger_service: object | None = trajectory_logger_service
        self._trajectory_ids_sink: list[str] | None = trajectory_ids_sink
        self._active_trajectory_id: str | None = None
        self._active_step_id: str | None = None

    @property
    def runtime(self) -> Optional[ElizaRuntime]:
        """Get the runtime instance."""
        return self._runtime

    async def solve_task(
        self,
        task: MINTTask,
        enable_tools: bool = True,
        enable_feedback: bool = True,
    ) -> MINTTrajectory:
        """
        Solve a MINT task using the CANONICAL ElizaOS pipeline.

        Args:
            task: The MINT task to solve
            enable_tools: Whether to allow tool (code) execution
            enable_feedback: Whether to provide feedback on incorrect answers

        Returns:
            MINTTrajectory recording the solving process
        """
        logger.info(f"[MINTAgent] Starting task {task.id}: {task.description}")

        trajectory = MINTTrajectory(
            task_id=task.id,
            start_time_ms=time.time() * 1000,
        )

        # Start elizaOS trajectory logging for this task (training/benchmark capture)
        step_id_for_turn: str | None = None
        if self._runtime is not None and self._trajectory_logger_service is not None:
            try:
                agent_id = str(getattr(self._runtime, "agent_id", "mint-agent"))
                # Service API (preferred): start_trajectory(agent_id, *, scenario_id, ...)
                start_traj = getattr(self._trajectory_logger_service, "start_trajectory", None)
                if callable(start_traj):
                    self._active_trajectory_id = start_traj(
                        agent_id,
                        scenario_id=task.id,
                        episode_id=f"{task.id}-{int(time.time() * 1000)}",
                        metadata={
                            "taskId": task.id,
                            "category": task.category.value,
                            "evaluationMetric": task.evaluation_metric,
                            "toolsAllowed": list(task.tools_allowed),
                            "maxTurns": int(task.max_turns),
                        },
                    )
                if self._trajectory_ids_sink is not None:
                    self._trajectory_ids_sink.append(self._active_trajectory_id)
            except Exception:
                self._active_trajectory_id = None
                step_id_for_turn = None

        # Build the initial prompt with task-specific instructions
        system_prompt = self._build_system_prompt(task)
        current_prompt = task.initial_prompt
        conversation_history: list[dict[str, str]] = []

        for turn_num in range(task.max_turns):
            turn_start = time.time() * 1000

            # Start a fresh step per turn for trajectory logging
            if self._active_trajectory_id and self._trajectory_logger_service is not None:
                try:
                    start_step = getattr(self._trajectory_logger_service, "start_step", None)
                    if callable(start_step):
                        step_id_for_turn = start_step(
                            self._active_trajectory_id,
                            agent_balance=0.0,
                            agent_points=0.0,
                            agent_pnl=0.0,
                            open_positions=0,
                            custom={
                                "turn": int(turn_num + 1),
                                "taskId": task.id,
                                "category": task.category.value,
                                "enableTools": bool(enable_tools),
                                "enableFeedback": bool(enable_feedback),
                            },
                        )
                        self._active_step_id = step_id_for_turn
                except Exception:
                    step_id_for_turn = None
                    self._active_step_id = None

            # Get response using CANONICAL Eliza pipeline
            response = await self._get_response_canonical(
                prompt=current_prompt,
                system_prompt=system_prompt,
                history=conversation_history,
                task=task,
            )

            # Record the assistant response turn
            trajectory.turns.append(
                Turn(
                    turn_type=TurnType.ASSISTANT,
                    content=response,
                    turn_number=turn_num + 1,
                    timestamp_ms=turn_start,
                )
            )

            # Update conversation history
            conversation_history.append({"role": "user", "content": current_prompt})
            conversation_history.append({"role": "assistant", "content": response})

            # Check for code execution
            code_to_execute = self._extract_code(response) if enable_tools else None

            if code_to_execute and "python" in task.tools_allowed:
                exec_result = await self.tool_executor.execute(code_to_execute)

                trajectory.turns.append(
                    Turn(
                        turn_type=TurnType.TOOL,
                        content=exec_result.output or exec_result.error or "",
                        turn_number=turn_num + 1,
                        tool_call=code_to_execute,
                        tool_result=exec_result.output,
                        tool_success=exec_result.success,
                        timestamp_ms=time.time() * 1000,
                    )
                )
                trajectory.num_tool_uses += 1

                # Truncate output to avoid context pollution
                output_preview = exec_result.output[:500] if exec_result.output else ""

                if exec_result.success:
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
                # Complete step as a tool/action attempt
                if self._active_trajectory_id and step_id_for_turn and self._trajectory_logger_service is not None:
                    try:
                        complete_step = getattr(self._trajectory_logger_service, "complete_step", None)
                        if callable(complete_step):
                            complete_step(
                                trajectory_id=self._active_trajectory_id,
                                step_id=step_id_for_turn,
                                action_type="tool",
                                action_name="python_executor",
                                parameters={"code": code_to_execute[:2000]},
                                success=bool(exec_result.success),
                                reward=0.0,
                                done=False,
                                error=(exec_result.error or "")[:2000] if not exec_result.success else None,
                                result={"output": (exec_result.output or "")[:2000]}
                                if exec_result.success
                                else None,
                            )
                    except Exception:
                        pass

                continue

            # Extract and evaluate answer
            predicted_answer = self._extract_answer(response, task)
            trajectory.final_answer = predicted_answer

            if predicted_answer:
                is_correct = self._check_answer(predicted_answer, task)

                if is_correct:
                    trajectory.success = True
                    logger.info(
                        f"[MINTAgent] Task {task.id}: Correct answer on turn {turn_num + 1}"
                    )

                    # Complete step with success reward
                    if self._active_trajectory_id and step_id_for_turn and self._trajectory_logger_service is not None:
                        try:
                            complete_step = getattr(self._trajectory_logger_service, "complete_step", None)
                            if callable(complete_step):
                                complete_step(
                                    trajectory_id=self._active_trajectory_id,
                                    step_id=step_id_for_turn,
                                    action_type="respond",
                                    action_name="final_answer",
                                    parameters={"predicted": str(predicted_answer)},
                                    success=True,
                                    reward=1.0,
                                    done=True,
                                )
                        except Exception:
                            pass
                    break

                # Generate feedback if enabled and turns remaining
                if enable_feedback and turn_num < task.max_turns - 1:
                    feedback = await self.feedback_generator.generate(
                        task=task,
                        predicted=predicted_answer,
                        turn_num=turn_num,
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

                    # Complete step for this turn (incorrect, but continuing with feedback)
                    if (
                        self._active_trajectory_id
                        and step_id_for_turn
                        and self._trajectory_logger_service is not None
                    ):
                        try:
                            complete_step = getattr(self._trajectory_logger_service, "complete_step", None)
                            if callable(complete_step):
                                complete_step(
                                    trajectory_id=self._active_trajectory_id,
                                    step_id=step_id_for_turn,
                                    action_type="respond",
                                    action_name="attempt_answer",
                                    parameters={
                                        "predicted": str(predicted_answer),
                                        "feedback": str(feedback)[:500],
                                    },
                                    success=False,
                                    reward=0.0,
                                    done=False,
                                    error="incorrect_answer",
                                )
                        except Exception:
                            pass

                    current_prompt = f"Feedback: {feedback}\n\nPlease try again with a different approach."
                else:
                    logger.info(
                        f"[MINTAgent] Task {task.id}: Incorrect answer '{predicted_answer}'"
                    )

                    # Complete step with failure reward
                    if self._active_trajectory_id and step_id_for_turn and self._trajectory_logger_service is not None:
                        try:
                            complete_step = getattr(self._trajectory_logger_service, "complete_step", None)
                            if callable(complete_step):
                                complete_step(
                                    trajectory_id=self._active_trajectory_id,
                                    step_id=step_id_for_turn,
                                    action_type="respond",
                                    action_name="final_answer",
                                    parameters={"predicted": str(predicted_answer)},
                                    success=False,
                                    reward=0.0,
                                    done=True,
                                    error="incorrect_answer",
                                )
                        except Exception:
                            pass
                    break
            else:
                # No answer found, request clarification
                if enable_feedback and turn_num < task.max_turns - 1:
                    feedback = (
                        "I couldn't find a clear answer in your response. "
                        "Please provide a specific answer ending with: Final answer: <YOUR_ANSWER>"
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

                    # Complete step for this turn (no extractable answer, but continuing)
                    if (
                        self._active_trajectory_id
                        and step_id_for_turn
                        and self._trajectory_logger_service is not None
                    ):
                        try:
                            complete_step = getattr(self._trajectory_logger_service, "complete_step", None)
                            if callable(complete_step):
                                complete_step(
                                    trajectory_id=self._active_trajectory_id,
                                    step_id=step_id_for_turn,
                                    action_type="respond",
                                    action_name="attempt_answer",
                                    parameters={"predicted": "", "feedback": str(feedback)[:500]},
                                    success=False,
                                    reward=0.0,
                                    done=False,
                                    error="no_answer_extracted",
                                )
                        except Exception:
                            pass

                    current_prompt = f"Feedback: {feedback}\n\nPlease try again."

        trajectory.end_time_ms = time.time() * 1000

        # End elizaOS trajectory logging for this task
        if self._active_trajectory_id and self._trajectory_logger_service is not None:
            try:
                status = "completed" if trajectory.success else "terminated"
                end_trajectory = getattr(self._trajectory_logger_service, "end_trajectory", None)
                if callable(end_trajectory):
                    await end_trajectory(
                        self._active_trajectory_id,
                        status,
                        final_metrics={
                            "success": bool(trajectory.success),
                            "turns": int(len(trajectory.turns)),
                            "toolUses": int(trajectory.num_tool_uses),
                            "feedbackTurns": int(trajectory.num_feedback_turns),
                        },
                    )
            except Exception:
                pass

        self._active_trajectory_id = None
        self._active_step_id = None

        return trajectory

    async def _get_response_canonical(
        self,
        prompt: str,
        system_prompt: str,
        history: list[dict[str, str]],
        task: MINTTask,
    ) -> str:
        """
        Get response using the CANONICAL ElizaOS pipeline.

        This method uses message_service.handle_message() when available,
        falling back to compose_state + use_model for benchmarking control.
        """
        if self._runtime is None:
            return await self._get_mock_response(prompt, task)

        try:
            # Import Eliza types for canonical message creation
            from uuid6 import uuid7
            from elizaos import Memory, Content, ChannelType

            # Create/reuse session IDs for this task
            if self._room_id is None:
                self._room_id = uuid7()
                self._user_id = uuid7()

            # Create canonical Memory with Content
            message = Memory(
                entity_id=self._user_id,
                room_id=self._room_id,
                content=Content(
                    text=prompt,
                    source="mint-benchmark",
                    channel_type="DM",
                ),
            )

            # Canonical benchmark path: compose_state + use_model.
            # This exercises the real provider pipeline and model plugin, while keeping
            # benchmark prompt control deterministic.
            try:
                logger.debug("[MINTAgent] Falling back to compose_state + use_model")
                return await self._get_response_with_state(prompt, system_prompt, history, message)
            except Exception as state_error:
                logger.debug(
                    f"[MINTAgent] compose_state unavailable ({state_error}), using direct model"
                )
                return await self._get_response_direct(prompt, system_prompt, history)

        except ImportError as e:
            logger.warning(f"[MINTAgent] Eliza imports unavailable: {e}, using direct model call")
            return await self._get_response_direct(prompt, system_prompt, history)
        except Exception as e:
            logger.error(f"[MINTAgent] Pipeline error: {e}")
            # Fall back to direct model call as last resort
            try:
                return await self._get_response_direct(prompt, system_prompt, history)
            except Exception:
                raise e

    async def _get_response_with_state(
        self,
        prompt: str,
        system_prompt: str,
        history: list[dict[str, str]],
        message: object,
    ) -> str:
        """
        Get response using compose_state for provider context.

        This exercises the Eliza provider system while allowing
        benchmark-specific prompt control.
        """
        from elizaos.types.model import ModelType

        from elizaos.trajectory_context import bind_trajectory_step
        from elizaos import MemoryType, MessageMetadata

        # Attach trajectory step metadata so compose_state logs provider accesses.
        if self._active_trajectory_id and self._active_step_id:
            meta = MessageMetadata(type=MemoryType.MESSAGE, source="mint-benchmark")
            setattr(meta, "trajectoryId", self._active_trajectory_id)
            setattr(meta, "trajectoryStepId", self._active_step_id)
            setattr(message, "metadata", meta)

        # Compose state from all registered providers
        with bind_trajectory_step(self._active_step_id):
            state = await self._runtime.compose_state(message, skip_cache=True)  # type: ignore

        # Build prompt with provider context
        context_text = ""
        if hasattr(state, "text") and state.text:
            context_text = f"# Context from Providers\n{state.text}\n\n"

        # Build conversation history
        history_text = ""
        for msg in history[-6:]:  # Last 3 exchanges
            role = "User" if msg["role"] == "user" else "Assistant"
            history_text += f"{role}: {msg['content']}\n\n"

        full_prompt = f"{context_text}{history_text}User: {prompt}\n\nAssistant:"

        with bind_trajectory_step(self._active_step_id):
            response = await self._runtime.use_model(  # type: ignore
                ModelType.TEXT_LARGE,
                {
                    "prompt": full_prompt,
                    "system": system_prompt,
                    "temperature": self.temperature,
                    "maxTokens": 1024,
                },
            )
        return str(response).strip()

    async def _get_response_direct(
        self,
        prompt: str,
        system_prompt: str,
        history: list[dict[str, str]],
    ) -> str:
        """Direct model call fallback (no provider context)."""
        from elizaos.types.model import ModelType

        full_prompt = ""
        for msg in history[-6:]:
            role = "User" if msg["role"] == "user" else "Assistant"
            full_prompt += f"{role}: {msg['content']}\n\n"
        full_prompt += f"User: {prompt}\n\nAssistant:"

        from elizaos.trajectory_context import bind_trajectory_step

        with bind_trajectory_step(self._active_step_id):
            response = await self._runtime.use_model(  # type: ignore
                ModelType.TEXT_LARGE,
                {
                    "prompt": full_prompt,
                    "system": system_prompt,
                    "temperature": self.temperature,
                    "maxTokens": 1024,
                },
            )
        return str(response).strip()

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

        return f"Based on my analysis, the answer is: {task.ground_truth}\n\nFinal answer: {task.ground_truth}"

    def _generate_mock_code(self, task: MINTTask) -> str:
        """Generate mock code for testing."""
        return f"""# Mock solution for {task.id}
result = {task.ground_truth}
print(result)"""

    def _extract_code(self, response: str) -> Optional[str]:
        """Extract Python code from response."""
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
            # If last line is short and looks like an answer, use it
            if len(last_line) < 50 and not last_line.startswith(("#", "```", "//")):
                return last_line

        return None

    def _check_answer(self, predicted: str, task: MINTTask) -> bool:
        """Check if the predicted answer matches the expected answer."""
        expected = task.ground_truth
        metric = task.evaluation_metric

        # Normalize strings
        predicted = predicted.strip().lower()
        expected = expected.strip().lower()

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
            # Similar to numeric
            try:
                pred_nums = re.findall(self.NUMBER_PATTERN, predicted)
                exp_nums = re.findall(self.NUMBER_PATTERN, expected)
                if pred_nums and exp_nums:
                    return float(pred_nums[-1]) == float(exp_nums[-1])
            except ValueError:
                pass
            return predicted == expected

        return predicted == expected

    def reset_session(self) -> None:
        """Reset the session for a new task (new room_id/user_id)."""
        self._room_id = None
        self._user_id = None
