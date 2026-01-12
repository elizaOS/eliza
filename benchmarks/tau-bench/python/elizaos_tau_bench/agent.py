"""
Tau Agent implementation for Tau-bench.
"""

import json
import re
import logging
from typing import Optional, Protocol, runtime_checkable

from elizaos_tau_bench.types import (
    TauBenchTask,
    ToolCall,
    ConversationTurn,
)
from elizaos_tau_bench.executor import ToolExecutor

logger = logging.getLogger(__name__)


@runtime_checkable
class IAgentRuntime(Protocol):
    """Protocol for ElizaOS agent runtime."""
    
    async def generate_text(
        self, input_text: str, options: dict[str, str]
    ) -> "GenerateTextResult":
        """Generate text from the LLM."""
        ...


class GenerateTextResult(Protocol):
    """Protocol for text generation result."""
    
    @property
    def text(self) -> str:
        """The generated text."""
        ...


class TauAgent:
    """Agent that processes Tau-bench tasks using the ElizaOS runtime."""

    def __init__(
        self,
        runtime: Optional[IAgentRuntime],
        executor: ToolExecutor,
        max_turns: int = 15,
    ) -> None:
        self.runtime = runtime
        self.executor = executor
        self.max_turns = max_turns
        self.conversation: list[ConversationTurn] = []

    async def process_task(
        self, task: TauBenchTask
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """
        Process a Tau-bench task and return:
        - List of tool calls made
        - Final response text
        - Full conversation history
        """
        tool_calls_made: list[ToolCall] = []
        self.conversation = []

        # Build initial system prompt with tools
        system_prompt = self._build_system_prompt(task)

        # Initialize conversation with history
        for msg in task.conversation_history:
            self.conversation.append(
                ConversationTurn(role=msg["role"], content=msg["content"])
            )

        # Add user instruction
        self.conversation.append(
            ConversationTurn(role="user", content=task.user_instruction)
        )

        final_response = ""

        # Agent loop
        for turn in range(self.max_turns):
            logger.debug(f"[TauAgent] Turn {turn + 1}/{self.max_turns}")

            # Generate response
            prompt = self._format_conversation(system_prompt)

            try:
                if self.runtime is not None:
                    # Use ElizaOS runtime for generation
                    response = await self.runtime.generate_text(
                        input_text=prompt,
                        options={"model_type": "text_large"},
                    )
                    response_text = response.text if hasattr(response, "text") else str(response)
                else:
                    # Mock response for testing
                    response_text = self._generate_mock_response(task, turn)
            except Exception as e:
                logger.error(f"[TauAgent] Generation error: {e}")
                final_response = f"Error generating response: {e}"
                break

            # Check for tool calls in response
            tool_call = self._extract_tool_call(response_text)

            if tool_call:
                # Execute tool
                logger.debug(f"[TauAgent] Executing tool: {tool_call.tool_name}")
                executed_call = await self.executor.execute(tool_call)
                tool_calls_made.append(executed_call)

                # Add tool call to conversation
                self.conversation.append(
                    ConversationTurn(
                        role="assistant",
                        content=response_text,
                        tool_call=executed_call,
                    )
                )

                # Add tool result to conversation
                self.conversation.append(
                    ConversationTurn(
                        role="tool",
                        content=json.dumps(executed_call.result, default=str),
                    )
                )
            else:
                # Final response (no more tool calls)
                final_response = self._clean_response(response_text)
                self.conversation.append(
                    ConversationTurn(role="assistant", content=final_response)
                )
                break

        return tool_calls_made, final_response, self.conversation

    def _build_system_prompt(self, task: TauBenchTask) -> str:
        """Build the system prompt with task context and available tools."""
        tools_desc = "\n".join(
            [
                f"- **{t.name}**: {t.description}\n  Parameters: {json.dumps(t.parameters)}"
                for t in task.available_tools
            ]
        )

        policies_desc = "\n".join(
            [f"- {p.policy_id}: {p.description}" for p in task.policy_constraints]
        )

        user_context = ""
        if task.user_profile:
            user_context = f"\n\nCustomer Profile:\n{task.user_profile}"

        return f"""You are a customer service agent for the {task.domain.value} domain.
Your goal is to help the customer with their request while following all policies.
{user_context}

## Available Tools

{tools_desc}

## Policy Constraints

{policies_desc}

## Instructions

1. Analyze the customer's request carefully
2. Use the appropriate tools to gather information and perform actions
3. Follow all policy constraints
4. Provide clear, helpful responses

## Tool Usage Format

To use a tool, include a tool call in your response using this exact format:

[TOOL_CALL]
{{"name": "tool_name", "arguments": {{"param1": "value1", "param2": "value2"}}}}
[/TOOL_CALL]

After receiving tool results, continue helping the customer or provide a final response.
When you have completed helping the customer, provide a final response WITHOUT any tool calls.
"""

    def _format_conversation(self, system_prompt: str) -> str:
        """Format the conversation for the LLM."""
        formatted = system_prompt + "\n\n## Conversation\n\n"

        for turn in self.conversation:
            if turn.role == "user":
                formatted += f"**Customer**: {turn.content}\n\n"
            elif turn.role == "assistant":
                formatted += f"**Agent**: {turn.content}\n\n"
            elif turn.role == "tool":
                formatted += f"**Tool Result**: {turn.content}\n\n"

        formatted += "**Agent**: "
        return formatted

    def _extract_tool_call(self, response: str) -> Optional[ToolCall]:
        """Extract tool call from response if present."""
        # Look for tool call markers
        match = re.search(
            r"\[TOOL_CALL\](.*?)\[/TOOL_CALL\]", response, re.DOTALL | re.IGNORECASE
        )
        if match:
            try:
                call_json = match.group(1).strip()
                call_data = json.loads(call_json)
                return ToolCall(
                    tool_name=call_data["name"],
                    arguments=call_data.get("arguments", {}),
                )
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"[TauAgent] Failed to parse tool call: {e}")
                return None

        # Also check for JSON-style function calls
        json_match = re.search(
            r'```json\s*\n?\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"arguments"\s*:\s*(\{[^}]*\})',
            response,
            re.DOTALL,
        )
        if json_match:
            try:
                tool_name = json_match.group(1)
                args_str = json_match.group(2)
                arguments = json.loads(args_str)
                return ToolCall(tool_name=tool_name, arguments=arguments)
            except (json.JSONDecodeError, IndexError) as e:
                logger.warning(f"[TauAgent] Failed to parse JSON tool call: {e}")
                return None

        return None

    def _clean_response(self, response: str) -> str:
        """Clean up the response by removing tool call markers."""
        # Remove tool call blocks
        cleaned = re.sub(r"\[TOOL_CALL\].*?\[/TOOL_CALL\]", "", response, flags=re.DOTALL)
        # Remove JSON code blocks
        cleaned = re.sub(r"```json\s*\n?.*?```", "", cleaned, flags=re.DOTALL)
        # Clean up whitespace
        cleaned = " ".join(cleaned.split())
        return cleaned.strip()

    def _generate_mock_response(self, task: TauBenchTask, turn: int) -> str:
        """Generate a mock response for testing without a real LLM."""
        # This is used when no runtime is provided
        if turn == 0 and task.expected_tool_calls:
            # Make the first expected tool call
            expected = task.expected_tool_calls[0]
            return f"""Let me help you with that. First, I'll look up the relevant information.

[TOOL_CALL]
{{"name": "{expected.tool_name}", "arguments": {json.dumps(expected.arguments)}}}
[/TOOL_CALL]
"""
        elif turn < len(task.expected_tool_calls):
            expected = task.expected_tool_calls[turn]
            return f"""Based on the information, I need to take another action.

[TOOL_CALL]
{{"name": "{expected.tool_name}", "arguments": {json.dumps(expected.arguments)}}}
[/TOOL_CALL]
"""
        else:
            # Final response
            if task.ground_truth_response:
                return task.ground_truth_response
            return "I've completed the requested action. Is there anything else I can help you with?"
