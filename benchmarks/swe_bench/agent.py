"""SWE-bench agent implementation using ElizaOS Python runtime."""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid, string_to_uuid

from .repo_manager import RepositoryManager
from .types import (
    AgentStep,
    AgentTrajectory,
    PatchStatus,
    SWEBenchInstance,
    SWEBenchResult,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


@dataclass
class AgentResponse:
    """Parsed response from the LLM."""

    thought: str
    action: str | None
    params: dict[str, str | int | float | bool | None]
    tokens: int


SYSTEM_PROMPT_TEMPLATE = """You are a software engineering agent tasked with resolving a GitHub issue.

Repository: {repo}

## Issue Description
{problem_statement}

{hints_section}

## Available Tools
You have access to these tools to investigate and fix the issue:

1. **SEARCH_CODE**: Search for patterns in the codebase
   - Use to find relevant code, function definitions, class usages
   - Parameters: query (required), file_pattern (optional, default: *.py)

2. **READ_FILE**: Read file contents
   - Use to examine specific files
   - Parameters: file_path (required), start_line (optional), end_line (optional)

3. **EDIT_FILE**: Make changes to files
   - Use to fix the issue by modifying code
   - Parameters: file_path (required), old_content (required), new_content (required)
   - The old_content must match exactly what's in the file

4. **LIST_FILES**: Browse repository structure
   - Use to understand the codebase organization
   - Parameters: directory (optional), pattern (optional)

5. **SUBMIT**: Submit your solution
   - Use when you've made all necessary changes
   - This generates a patch from your changes

## Strategy
1. **Understand**: Read the issue carefully. What is the bug or feature request?
2. **Locate**: Search for relevant code. Find where the issue occurs.
3. **Analyze**: Read the relevant files. Understand the code structure.
4. **Fix**: Make minimal, targeted changes to resolve the issue.
5. **Verify**: Ensure your changes are correct and complete.
6. **Submit**: When confident, submit your solution.

## Important Guidelines
- Make minimal changes - only modify what's necessary
- Preserve existing code style and conventions
- Don't add unnecessary features or refactoring
- Ensure backward compatibility
- Consider edge cases

When you're ready to make your final submission, use the SUBMIT action.

Now, let's solve this issue step by step.
"""


class SWEAgent:
    """Agent for solving SWE-bench issues."""

    def __init__(
        self,
        runtime: AgentRuntime,
        repo_manager: RepositoryManager,
        max_steps: int = 30,
    ):
        self.runtime = runtime
        self.repo_manager = repo_manager
        self.max_steps = max_steps
        self.trajectory: AgentTrajectory | None = None

    async def solve_issue(self, instance: SWEBenchInstance) -> SWEBenchResult:
        """Attempt to solve a SWE-bench issue and return the result."""
        start_time = time.time()
        tokens_used = 0

        # Initialize trajectory tracking
        self.trajectory = AgentTrajectory(
            instance_id=instance.instance_id,
            steps=[],
            files_viewed=[],
            files_edited=[],
            search_queries=[],
            total_tokens=0,
        )

        try:
            # Setup repository
            await self.repo_manager.setup_repo(instance)

            # Build system prompt
            hints_section = ""
            if instance.hints_text:
                hints_section = f"## Hints\n{instance.hints_text}"

            system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
                repo=instance.repo,
                problem_statement=instance.problem_statement,
                hints_section=hints_section,
            )

            # Initialize conversation with system context
            conversation_history: list[dict[str, str]] = []

            # Initial message to start the agent
            conversation_history.append(
                {
                    "role": "system",
                    "content": system_prompt,
                }
            )

            conversation_history.append(
                {
                    "role": "user",
                    "content": "Please analyze this issue and fix it. Start by understanding the problem and locating relevant code.",
                }
            )

            # Agent loop
            submitted = False
            generated_patch = ""

            for step_num in range(self.max_steps):
                logger.info(f"Step {step_num + 1}/{self.max_steps}")

                # Get agent response
                response = await self._get_agent_response(conversation_history)
                tokens_used += response.tokens

                response_text = response.thought
                action_name = response.action
                action_params = response.params

                # Record step
                step = AgentStep(
                    step_number=step_num + 1,
                    action=action_name or "THINK",
                    action_input=action_params,
                    observation="",
                    thought=response_text,
                )

                # Execute action if specified
                if action_name:
                    observation = await self._execute_action(action_name, action_params)
                    step.observation = observation

                    # Track files and queries
                    if action_name == "SEARCH_CODE" and "query" in action_params:
                        query_val = action_params.get("query")
                        if query_val is not None:
                            self.trajectory.search_queries.append(str(query_val))
                    elif action_name == "READ_FILE" and "file_path" in action_params:
                        file_path_val = action_params.get("file_path")
                        if file_path_val is not None:
                            file_path_str = str(file_path_val)
                            if file_path_str not in self.trajectory.files_viewed:
                                self.trajectory.files_viewed.append(file_path_str)
                    elif action_name == "EDIT_FILE" and "file_path" in action_params:
                        file_path_val = action_params.get("file_path")
                        if file_path_val is not None:
                            file_path_str = str(file_path_val)
                            if file_path_str not in self.trajectory.files_edited:
                                self.trajectory.files_edited.append(file_path_str)
                    elif action_name == "SUBMIT":
                        submitted = True
                        generated_patch = await self.repo_manager.get_diff()

                    # Add observation to conversation
                    conversation_history.append(
                        {
                            "role": "assistant",
                            "content": response_text,
                        }
                    )
                    conversation_history.append(
                        {
                            "role": "user",
                            "content": f"Tool result:\n{observation}\n\nContinue with your analysis.",
                        }
                    )
                else:
                    conversation_history.append(
                        {
                            "role": "assistant",
                            "content": response_text,
                        }
                    )
                    conversation_history.append(
                        {
                            "role": "user",
                            "content": "Please take an action using one of the available tools.",
                        }
                    )

                self.trajectory.steps.append(step)

                if submitted:
                    break

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

    async def _get_agent_response(
        self, conversation_history: list[dict[str, str]]
    ) -> AgentResponse:
        """Get response from the LLM through ElizaOS runtime."""
        # Combine conversation into a prompt
        prompt_parts: list[str] = []
        for msg in conversation_history:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "system":
                prompt_parts.append(f"SYSTEM:\n{content}")
            elif role == "user":
                prompt_parts.append(f"USER:\n{content}")
            elif role == "assistant":
                prompt_parts.append(f"ASSISTANT:\n{content}")

        prompt_parts.append(
            """
ASSISTANT: I will analyze the situation and take appropriate action.

Please respond with:
1. Your thinking about what to do next
2. The action to take (one of: SEARCH_CODE, READ_FILE, EDIT_FILE, LIST_FILES, SUBMIT)
3. The parameters for the action as JSON

Format your response like this:
THOUGHT: [your reasoning]
ACTION: [action name]
PARAMS: [JSON parameters]

If you want to submit your solution, use ACTION: SUBMIT with no parameters.
"""
        )

        full_prompt = "\n\n".join(prompt_parts)

        try:
            # Use the runtime's generate_text method
            from elizaos.types.model import GenerateTextOptions
            
            # NOTE: Do not override modelType here unless you are certain the
            # runtime has a handler registered for that string. By default the
            # runtime uses ModelType.TEXT_LARGE ("TEXT_LARGE"), which is what
            # we register for benchmark runs.
            options = GenerateTextOptions(
                temperature=0.1,
                maxTokens=2000,
            )
            result = await self.runtime.generate_text(
                input_text=full_prompt,
                options=options,
            )

            response_text = result.text if hasattr(result, "text") else str(result)

            # Parse the response to extract action and params
            action_name: str | None = None
            action_params: dict[str, str | int | float | bool | None] = {}
            thought = response_text

            if "ACTION:" in response_text:
                parts = response_text.split("ACTION:")
                thought = parts[0].replace("THOUGHT:", "").strip()

                action_part = parts[1]
                if "PARAMS:" in action_part:
                    action_name = action_part.split("PARAMS:")[0].strip()
                    params_str = action_part.split("PARAMS:")[1].strip()

                    # Try to parse JSON params
                    try:
                        # Find JSON object in the string
                        start_idx = params_str.find("{")
                        end_idx = params_str.rfind("}") + 1
                        if start_idx >= 0 and end_idx > start_idx:
                            parsed = json.loads(params_str[start_idx:end_idx])
                            if isinstance(parsed, dict):
                                action_params = parsed
                    except json.JSONDecodeError:
                        logger.warning(f"Failed to parse action params: {params_str}")
                else:
                    action_words = action_part.strip().split()
                    action_name = action_words[0] if action_words else None

            # Estimate token usage
            token_estimate = len(full_prompt.split()) + len(response_text.split())

            return AgentResponse(
                thought=thought,
                action=action_name,
                params=action_params,
                tokens=token_estimate,
            )

        except Exception as e:
            logger.error(f"Error getting agent response: {e}")
            return AgentResponse(thought=str(e), action=None, params={}, tokens=0)

    async def _execute_action(
        self, action_name: str, params: dict[str, str | int | float | bool | None]
    ) -> str:
        """Execute an action via the ElizaOS runtime action system.

        This exercises:
        - action lookup/registration
        - action parameter validation
        - services (RepoManagerService) resolution
        """
        action_name_upper = action_name.upper()

        try:
            # Create a synthetic message/response pair so the runtime can execute actions
            instance_id = (
                self.repo_manager.current_instance.instance_id
                if self.repo_manager.current_instance
                else "unknown"
            )
            room_id = string_to_uuid(f"swebench:{instance_id}")
            message_id = as_uuid(str(uuid.uuid4()))

            message = Memory(
                id=message_id,
                entityId=self.runtime.agent_id,
                agentId=self.runtime.agent_id,
                roomId=room_id,
                createdAt=int(time.time() * 1000),
                content=Content(text="SWE-bench action execution"),
            )

            response_content = Content(text="", actions=[action_name_upper])
            # Content supports extra fields; the runtime looks for `content.params`.
            setattr(response_content, "params", {action_name_upper: params})

            response = Memory(
                id=as_uuid(str(uuid.uuid4())),
                entityId=self.runtime.agent_id,
                agentId=self.runtime.agent_id,
                roomId=room_id,
                createdAt=int(time.time() * 1000),
                content=response_content,
            )

            await self.runtime.process_actions(message, [response], state=None, callback=None)

            results = self.runtime.get_action_results(message_id)
            if not results:
                return f"No action results produced for {action_name_upper}"

            result = results[-1]
            if not result.success:
                return f"Action failed: {result.error or 'unknown error'}"

            data = result.data or {}

            if action_name_upper == "SEARCH_CODE":
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

            if action_name_upper == "READ_FILE":
                content = data.get("content", "")
                return str(content)

            if action_name_upper == "EDIT_FILE":
                return str(data.get("message", "Edit completed"))

            if action_name_upper == "LIST_FILES":
                files = data.get("files", [])
                total = data.get("total_count", 0)
                if not isinstance(files, list):
                    return "LIST_FILES: malformed result"
                return f"Files ({total} total):\n" + "\n".join([str(f) for f in files[:50]])

            if action_name_upper == "SUBMIT":
                # Avoid echoing the full patch into the conversation history.
                has_changes = bool(data.get("has_changes", False))
                patch_bytes = 0
                patch_val = data.get("patch")
                if isinstance(patch_val, str):
                    patch_bytes = len(patch_val.encode("utf-8", errors="replace"))
                return f"Submitted. has_changes={has_changes}. patch_bytes={patch_bytes}"

            return f"{action_name_upper}: success"

        except Exception as e:
            logger.error(f"Error executing action {action_name}: {e}")
            return f"Error: {str(e)}"
