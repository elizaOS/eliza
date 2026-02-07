"""SWE-bench agent implementation using canonical ElizaOS message handling."""

from __future__ import annotations

import logging
import re
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid, string_to_uuid
from elizaos.types.memory import MemoryType, MessageMetadata

from .providers import (
    SWEBenchActionResultsProvider,
    set_current_instance,
)
from .repo_manager import RepositoryManager
from .tools import REPO_MANAGER_KEY
from .types import (
    AgentStep,
    AgentTrajectory,
    PatchStatus,
    SWEBenchInstance,
    SWEBenchResult,
)

# Trajectory logger integration (optional)
try:
    from elizaos_plugin_trajectory_logger import (
        TrajectoryLoggerService,
        ActionAttempt,
        EnvironmentState,
        Trajectory,
    )
    TRAJECTORY_LOGGER_AVAILABLE = True
except ImportError:
    TRAJECTORY_LOGGER_AVAILABLE = False
    TrajectoryLoggerService = None  # type: ignore[misc, assignment]
    ActionAttempt = None  # type: ignore[misc, assignment]
    EnvironmentState = None  # type: ignore[misc, assignment]
    Trajectory = None  # type: ignore[misc, assignment]

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


@dataclass
class ParsedResponse:
    """Parsed response from the model."""

    thought: str
    text: str
    action: str | None
    params: dict[str, str | int | float | bool | None]


def parse_xml_response(response_text: str) -> ParsedResponse:
    """Parse XML-formatted response from the model.
    
    Expected format:
    <response>
    <thought>...</thought>
    <text>...</text>
    <actions>ACTION_NAME</actions>
    <params>
    <ACTION_NAME>
    <param_name>value</param_name>
    </ACTION_NAME>
    </params>
    </response>
    """
    thought = ""
    text = ""
    action: str | None = None
    params: dict[str, str | int | float | bool | None] = {}

    # Try to extract content from XML tags
    try:
        # Handle incomplete XML by wrapping if needed
        if "<response>" not in response_text:
            response_text = f"<response>{response_text}</response>"
        if "</response>" not in response_text:
            response_text = response_text + "</response>"

        # Extract the response element
        match = re.search(r"<response>(.*?)</response>", response_text, re.DOTALL)
        if match:
            xml_content = f"<response>{match.group(1)}</response>"
            root = ET.fromstring(xml_content)

            thought_elem = root.find("thought")
            if thought_elem is not None and thought_elem.text:
                thought = thought_elem.text.strip()

            text_elem = root.find("text")
            if text_elem is not None and text_elem.text:
                text = text_elem.text.strip()

            actions_elem = root.find("actions")
            if actions_elem is not None and actions_elem.text:
                action = actions_elem.text.strip().upper()

            params_elem = root.find("params")
            if params_elem is not None and action:
                # Look for action-specific params
                action_params = params_elem.find(action)
                if action_params is not None:
                    for param_elem in list(action_params):
                        param_value = param_elem.text
                        if param_value is not None:
                            # Try to parse as number or bool
                            parsed_value = _parse_param_value(param_value)
                            params[param_elem.tag] = parsed_value
    except ET.ParseError:
        logger.debug("XML parse failed, trying regex fallback")

    # Fallback: try regex extraction if XML parsing failed
    if not thought and not action:
        # Try to extract thought
        thought_match = re.search(r"<thought>(.*?)</thought>", response_text, re.DOTALL)
        if thought_match:
            thought = thought_match.group(1).strip()

        # Try to extract text
        text_match = re.search(r"<text>(.*?)</text>", response_text, re.DOTALL)
        if text_match:
            text = text_match.group(1).strip()

        # Try to extract action
        action_match = re.search(r"<actions>\s*(\w+)\s*</actions>", response_text)
        if action_match:
            action = action_match.group(1).upper()

    # Final fallback: check for legacy format
    if not action:
        if "ACTION:" in response_text:
            parts = response_text.split("ACTION:")
            if len(parts) > 1:
                action_line = parts[1].split("\n")[0].strip()
                action = action_line.split()[0].upper() if action_line.split() else None

    return ParsedResponse(thought=thought, text=text, action=action, params=params)


def _parse_param_value(value: str) -> str | int | float | bool | None:
    """Parse a parameter value string to appropriate type."""
    raw = value.strip()
    if raw == "":
        return None
    lower = raw.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower == "null":
        return None
    # Try int first, then float
    try:
        if re.fullmatch(r"-?\d+", raw):
            return int(raw)
        if re.fullmatch(r"-?\d+\.\d+", raw):
            return float(raw)
    except ValueError:
        pass
    return raw


class SWEAgent:
    """Agent for solving SWE-bench issues using canonical ElizaOS message handling."""

    def __init__(
        self,
        runtime: AgentRuntime,
        repo_manager: RepositoryManager,
        max_steps: int = 30,
        trajectory_logger: TrajectoryLoggerService | None = None,
    ):
        self.runtime = runtime
        self.repo_manager = repo_manager
        self.max_steps = max_steps
        self.trajectory: AgentTrajectory | None = None
        
        # Trajectory logger for training data export
        self.trajectory_logger = trajectory_logger
        self._trajectory_id: str | None = None

        # Room/entity IDs for this session
        self._room_id = string_to_uuid("swebench:session")
        self._user_id = string_to_uuid("swebench:user")

    async def solve_issue(self, instance: SWEBenchInstance) -> SWEBenchResult:
        """Attempt to solve a SWE-bench issue using canonical ElizaOS flow.
        
        This method:
        1. Sets up the repository
        2. Sets the current instance for providers
        3. Uses message_service.handle_message() for each step
        4. Processes actions through the canonical runtime.process_actions()
        5. Logs trajectory data for training (if trajectory_logger is set)
        6. Returns the result
        """
        start_time = time.time()
        tokens_used = 0
        final_status = "completed"
        max_steps_reached = False

        # Initialize trajectory tracking
        self.trajectory = AgentTrajectory(
            instance_id=instance.instance_id,
            steps=[],
            files_viewed=[],
            files_edited=[],
            search_queries=[],
            total_tokens=0,
        )

        # Start trajectory logging if available
        if self.trajectory_logger and TRAJECTORY_LOGGER_AVAILABLE:
            self._trajectory_id = self.trajectory_logger.start_trajectory(
                agent_id=str(self.runtime.agent_id),
                scenario_id=instance.instance_id,
                episode_id=instance.instance_id,
                metadata={
                    "repo": instance.repo,
                    "base_commit": instance.base_commit,
                    "problem_statement": instance.problem_statement[:500],
                    "benchmark": "swe-bench",
                },
            )

        # Clear action results from previous runs
        SWEBenchActionResultsProvider.clear_results()

        try:
            # Setup repository
            await self.repo_manager.setup_repo(instance)

            # Set current instance for providers
            set_current_instance(instance)

            # Create room-specific IDs for this instance
            self._room_id = string_to_uuid(f"swebench:{instance.instance_id}")

            # Agent loop using canonical message handling
            submitted = False
            generated_patch = ""

            # Initial message to start the agent
            initial_message = Memory(
                id=as_uuid(str(uuid.uuid4())),
                entity_id=self._user_id,
                agent_id=self.runtime.agent_id,
                room_id=self._room_id,
                created_at=int(time.time() * 1000),
                content=Content(
                    text="Please analyze this issue and fix it. Start by understanding the problem and locating relevant code.",
                    source="swebench",
                    channel_type="API",
                ),
            )

            for step_num in range(self.max_steps):
                logger.info(f"Step {step_num + 1}/{self.max_steps}")
                step_start_time = time.time()

                # Start trajectory step logging
                step_id: str | None = None
                if self.trajectory_logger and self._trajectory_id and TRAJECTORY_LOGGER_AVAILABLE:
                    env_state = EnvironmentState(
                        timestamp=int(time.time() * 1000),
                        agent_balance=0.0,
                        agent_points=float(step_num),
                        agent_pnl=0.0,
                        open_positions=0,
                        custom={
                            "step_number": step_num + 1,
                            "max_steps": self.max_steps,
                            "files_edited_count": len(self.trajectory.files_edited) if self.trajectory else 0,
                            "files_viewed_count": len(self.trajectory.files_viewed) if self.trajectory else 0,
                        },
                    )
                    step_id = self.trajectory_logger.start_step(self._trajectory_id, env_state)

                # Use canonical message service
                message_to_send = initial_message if step_num == 0 else self._create_continuation_message()
                llm_start_time = time.time()

                # Attach trajectoryStepId to message metadata so runtime can log provider/model calls
                if step_id:
                    try:
                        message_to_send.metadata = MessageMetadata(
                            type=MemoryType.MESSAGE,
                            source="swebench",
                            timestamp=int(time.time() * 1000),
                            trajectoryStepId=step_id,  # type: ignore[call-arg]
                            instanceId=instance.instance_id,  # type: ignore[call-arg]
                        )
                    except Exception:
                        pass

                # Call the canonical message handling flow
                result = await self.runtime.message_service.handle_message(
                    self.runtime,
                    message_to_send,
                )
                llm_latency_ms = int((time.time() - llm_start_time) * 1000)

                # Estimate tokens from response
                response_text = result.response_content.text if result.response_content else ""
                estimated_tokens = len(response_text.split()) * 2  # Rough estimate
                tokens_used += estimated_tokens

                # LLM calls + provider accesses are logged centrally by runtime hooks
                _ = llm_latency_ms

                # Get actions from message service (already parsed from XML)
                # The message service parses <actions>, <thought>, <text>, and <params>
                response_actions = result.response_content.actions if result.response_content else None
                response_thought = result.response_content.thought if result.response_content else None
                response_params = getattr(result.response_content, "params", None) if result.response_content else None

                # Initialize variables for action, params, thought
                action: str | None = None
                params: dict[str, str | int | float | bool | None] = {}
                thought: str = ""

                # If message service didn't parse actions, try parsing the text as fallback
                if not response_actions:
                    parsed = parse_xml_response(response_text)
                    action = parsed.action
                    params = parsed.params
                    thought = parsed.thought
                else:
                    # Use parsed results from message service
                    action = response_actions[0] if response_actions else None
                    thought = response_thought or ""
                    
                    # Parse params from the response content
                    if response_params and action:
                        action_params = response_params.get(action.upper(), {})
                        if isinstance(action_params, dict):
                            params = action_params

                # Record step
                step = AgentStep(
                    step_number=step_num + 1,
                    action=action or "THINK",
                    action_input=params,
                    observation="",
                    thought=thought,
                )

                # Execute action if specified
                action_success = True
                action_error: str | None = None
                if action:
                    observation = await self._execute_action(action, params)
                    step.observation = observation
                    
                    # Check if action failed
                    if observation.startswith("Error:") or observation.startswith("Action failed:"):
                        action_success = False
                        action_error = observation

                    # Track files and queries
                    self._track_action(action, params)

                    # Add to action results provider for context
                    SWEBenchActionResultsProvider.add_result(action, observation)

                    if action == "SUBMIT":
                        submitted = True
                        generated_patch = await self.repo_manager.get_diff()

                # Complete trajectory step logging
                if self.trajectory_logger and self._trajectory_id and step_id and TRAJECTORY_LOGGER_AVAILABLE:
                    action_attempt = ActionAttempt(
                        attempt_id=str(uuid.uuid4()),
                        timestamp=int(time.time() * 1000),
                        action_type="swe_bench_tool",
                        action_name=action or "THINK",
                        parameters={k: v for k, v in params.items() if v is not None},
                        reasoning=thought,
                        success=action_success,
                        result={"observation": step.observation[:500]} if step.observation else None,
                        error=action_error,
                    )
                    # Reward based on action type and success
                    step_reward = self._compute_step_reward(action, action_success, submitted)
                    done = bool(submitted) or (step_num == self.max_steps - 1)
                    self.trajectory_logger.complete_step(
                        self._trajectory_id,
                        step_id,
                        action=action_attempt,
                        reward=step_reward,
                    )
                    # Mark done if terminal (the adapter service will also ensure final step done)
                    try:
                        traj = self.trajectory_logger.get_active_trajectory(self._trajectory_id)
                        if traj and traj.steps:
                            traj.steps[-1].done = done
                    except Exception:
                        pass

                self.trajectory.steps.append(step)

                if submitted:
                    break

                if step_num == self.max_steps - 1:
                    max_steps_reached = True

            # If we didn't get an explicit submit, get the diff anyway
            if not generated_patch:
                generated_patch = await self.repo_manager.get_diff()

            duration = time.time() - start_time
            self.trajectory.total_tokens = tokens_used

            # Determine patch status
            if not generated_patch.strip():
                patch_status = PatchStatus.NOT_GENERATED
            else:
                patch_status = PatchStatus.GENERATED

            # End trajectory logging
            if self.trajectory_logger and self._trajectory_id and TRAJECTORY_LOGGER_AVAILABLE:
                if max_steps_reached and not submitted:
                    final_status = "terminated"
                await self.trajectory_logger.end_trajectory(
                    self._trajectory_id,
                    status=final_status,  # type: ignore[arg-type]
                    final_metrics={
                        "patch_generated": patch_status == PatchStatus.GENERATED,
                        "submitted": submitted,
                        "steps_taken": len(self.trajectory.steps) if self.trajectory else 0,
                        "tokens_used": tokens_used,
                        "duration_seconds": duration,
                        "files_edited": len(self.trajectory.files_edited) if self.trajectory else 0,
                        "files_viewed": len(self.trajectory.files_viewed) if self.trajectory else 0,
                    },
                )

            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=generated_patch,
                patch_status=patch_status,
                tests_passed=[],
                tests_failed=[],
                success=False,  # Will be determined by evaluator
                duration_seconds=duration,
                tokens_used=tokens_used,
                trajectory=self.trajectory,
            )

        except Exception as e:
            logger.error(f"Error solving issue {instance.instance_id}: {e}")
            duration = time.time() - start_time
            final_status = "error"

            # End trajectory logging with error status
            if self.trajectory_logger and self._trajectory_id and TRAJECTORY_LOGGER_AVAILABLE:
                await self.trajectory_logger.end_trajectory(
                    self._trajectory_id,
                    status="error",
                    final_metrics={
                        "error": str(e),
                        "steps_taken": len(self.trajectory.steps) if self.trajectory else 0,
                        "tokens_used": tokens_used,
                        "duration_seconds": duration,
                    },
                )

            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch="",
                patch_status=PatchStatus.NOT_GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=duration,
                tokens_used=tokens_used,
                error=str(e),
                trajectory=self.trajectory,
            )
        finally:
            # Clear instance context
            set_current_instance(None)
    
    def _compute_step_reward(
        self, action: str | None, success: bool, submitted: bool
    ) -> float:
        """Compute reward for a step based on action and outcome."""
        if not action:
            return 0.0
        
        # Positive reward for productive actions
        rewards: dict[str, float] = {
            "SEARCH_CODE": 0.1,   # Exploring the codebase
            "READ_FILE": 0.2,    # Understanding code
            "EDIT_FILE": 0.3,    # Making changes
            "LIST_FILES": 0.05,  # Basic exploration
            "SUBMIT": 0.5 if submitted else 0.0,  # Submitting solution
        }
        
        base_reward = rewards.get(action.upper(), 0.0)
        
        # Penalty for failed actions
        if not success:
            return base_reward * 0.5 - 0.1
        
        return base_reward
    
    def get_logged_trajectory(self) -> Trajectory | None:
        """Get the trajectory from the trajectory logger for export.
        
        Returns the trajectory data in the format used by the trajectory logger
        plugin, suitable for export to ART/GRPO training formats.
        """
        if not self.trajectory_logger or not self._trajectory_id:
            return None
        return self.trajectory_logger.get_active_trajectory(self._trajectory_id)

    def _create_continuation_message(self) -> Memory:
        """Create a continuation message for the next step."""
        return Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=self._user_id,
            agent_id=self.runtime.agent_id,
            room_id=self._room_id,
            created_at=int(time.time() * 1000),
            content=Content(
                text="Continue with your analysis. Take the next action.",
                source="swebench",
                channel_type="API",
            ),
        )

    def _track_action(self, action: str, params: dict[str, str | int | float | bool | None]) -> None:
        """Track action for trajectory."""
        if not self.trajectory:
            return

        if action == "SEARCH_CODE" and "query" in params:
            query_val = params.get("query")
            if query_val is not None:
                self.trajectory.search_queries.append(str(query_val))
        elif action == "READ_FILE" and "file_path" in params:
            file_path_val = params.get("file_path")
            if file_path_val is not None:
                file_path_str = str(file_path_val)
                if file_path_str not in self.trajectory.files_viewed:
                    self.trajectory.files_viewed.append(file_path_str)
        elif action == "EDIT_FILE" and "file_path" in params:
            file_path_val = params.get("file_path")
            if file_path_val is not None:
                file_path_str = str(file_path_val)
                if file_path_str not in self.trajectory.files_edited:
                    self.trajectory.files_edited.append(file_path_str)

    async def _execute_action(
        self, action_name: str, params: dict[str, str | int | float | bool | None]
    ) -> str:
        """Execute an action via the ElizaOS runtime action system.

        This uses the canonical runtime.process_actions() method which:
        - Looks up the action by name
        - Validates parameters
        - Resolves services (RepoManagerService)
        - Executes the action handler
        - Returns the result
        """
        action_name_upper = action_name.upper()

        try:
            # Create a message for action execution
            message_id = as_uuid(str(uuid.uuid4()))

            message = Memory(
                id=message_id,
                entity_id=self.runtime.agent_id,
                agent_id=self.runtime.agent_id,
                room_id=self._room_id,
                created_at=int(time.time() * 1000),
                content=Content(text="SWE-bench action execution"),
            )

            # Create response with action in the canonical format
            response_content = Content(
                text="",
                actions=[action_name_upper],
            )
            # Set params in the format expected by runtime._parse_action_params
            setattr(response_content, "params", {action_name_upper: params})

            response = Memory(
                id=as_uuid(str(uuid.uuid4())),
                entity_id=self.runtime.agent_id,
                agent_id=self.runtime.agent_id,
                room_id=self._room_id,
                created_at=int(time.time() * 1000),
                content=response_content,
            )

            # Use canonical action processing
            await self.runtime.process_actions(message, [response], state=None, callback=None)

            # Get results from the runtime
            results = self.runtime.get_action_results(message_id)
            if not results:
                return f"No action results produced for {action_name_upper}"

            result = results[-1]
            if not result.success:
                return f"Action failed: {result.error or 'unknown error'}"

            # Format result based on action type
            return self._format_action_result(action_name_upper, result.data)

        except Exception as e:
            logger.error(f"Error executing action {action_name}: {e}")
            return f"Error: {str(e)}"

    def _format_action_result(
        self, action_name: str, data: dict[str, object] | None
    ) -> str:
        """Format action result for display."""
        if not data:
            return f"{action_name}: success (no data)"

        if action_name == "SEARCH_CODE":
            matches = data.get("matches", [])
            total = data.get("total_matches", 0)
            if not isinstance(matches, list):
                return "SEARCH_CODE: malformed result"
            lines = [f"Found {total} matches:"]
            for m in matches[:20]:
                if isinstance(m, dict):
                    fp = m.get("file_path", "")
                    ln = m.get("start_line", "")
                    content = m.get("content", "")
                    lines.append(f"  {fp}:{ln}: {str(content)[:120]}")
            return "\n".join(lines)

        if action_name == "READ_FILE":
            content = data.get("content", "")
            return str(content)

        if action_name == "EDIT_FILE":
            return str(data.get("message", "Edit completed"))

        if action_name == "LIST_FILES":
            files = data.get("files", [])
            total = data.get("total_count", 0)
            if not isinstance(files, list):
                return "LIST_FILES: malformed result"
            return f"Files ({total} total):\n" + "\n".join([str(f) for f in files[:50]])

        if action_name == "SUBMIT":
            has_changes = bool(data.get("has_changes", False))
            patch_val = data.get("patch")
            patch_bytes = 0
            if isinstance(patch_val, str):
                patch_bytes = len(patch_val.encode("utf-8", errors="replace"))
            return f"Submitted. has_changes={has_changes}. patch_bytes={patch_bytes}"

        return f"{action_name}: success"
