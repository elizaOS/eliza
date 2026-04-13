"""Tau-bench agent backed by the milady benchmark server."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from milady_adapter.client import MiladyClient

from elizaos_tau_bench.types import (
    ConversationTurn,
    TauBenchTask,
    ToolCall,
)
from elizaos_tau_bench.executor import ToolExecutor

logger = logging.getLogger(__name__)


def _extract_xml_tag(text: str, tag: str) -> str | None:
    """Extract content between <tag>...</tag> from text."""
    import re

    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


class MiladyTauAgent:
    """Tau-bench agent that delegates to the milady TypeScript agent.

    Drop-in replacement for ``ElizaOSTauAgent`` — same ``process_task``
    interface but routes LLM calls through the milady benchmark server.
    """

    def __init__(
        self,
        executor: ToolExecutor,
        max_turns: int = 15,
        client: MiladyClient | None = None,
    ) -> None:
        self.executor = executor
        self.max_turns = max_turns
        self._client = client or MiladyClient()
        self.conversation: list[ConversationTurn] = []

    async def initialize(self) -> None:
        """Verify the milady server is reachable."""
        self._client.wait_until_ready(timeout=120)

    async def process_task(
        self,
        task: TauBenchTask,
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """Process a Tau-bench task using milady.

        Returns (tool_calls, final_response, conversation).
        """
        self.conversation = []
        tool_calls_made: list[ToolCall] = []
        final_response = ""

        # Reset session
        self._client.reset(task_id=task.task_id, benchmark="tau_bench")

        # Format tool definitions for context
        tools_for_context = [
            {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
            for t in task.available_tools
        ]

        # Format policies
        policies_for_context = [
            {"policy_id": p.policy_id, "description": p.description}
            for p in task.policy_constraints
        ]

        # Initialize conversation from history
        for msg in task.conversation_history:
            self.conversation.append(
                ConversationTurn(role=msg["role"], content=msg["content"])
            )
        self.conversation.append(
            ConversationTurn(role="user", content=task.user_instruction)
        )

        last_tool_result: object = None

        for turn in range(self.max_turns):
            # Build message
            if turn == 0:
                message_text = task.user_instruction
            elif last_tool_result is not None:
                result_str = json.dumps(last_tool_result, default=str)[:1000]
                message_text = (
                    f"Tool result: {result_str}\n\n"
                    "Based on this result, either call another tool if needed, "
                    "or provide the final response to the customer."
                )
            else:
                message_text = "Continue helping the customer."

            context: dict[str, object] = {
                "benchmark": "tau_bench",
                "task_id": task.task_id,
                "goal": task.user_goal or task.user_instruction,
                "tools": tools_for_context,
            }
            if task.user_profile:
                context["user_profile"] = task.user_profile
            if policies_for_context:
                context["policies"] = policies_for_context
            if task.success_criteria:
                context["success_criteria"] = task.success_criteria
            if last_tool_result is not None:
                context["last_tool_result"] = last_tool_result

            response = self._client.send_message(text=message_text, context=context)

            logger.info(
                "Milady response: text_len=%d, actions=%s, params_keys=%s, has_tool_xml=%s",
                len(response.text or ""),
                response.actions,
                list(response.params.keys()),
                "<tool_name>" in (response.text or ""),
            )

            # Check if milady wants to call a tool.
            # The TS runtime may strip XML from response text, so we check
            # params, text, and thought for tool call information.
            tool_name = response.params.get("tool_name")
            arguments_from_text: str | None = None

            # Check all text sources for XML tool tags
            all_text = "\n".join(filter(None, [
                response.text,
                response.thought,
                str(response.params) if response.params else "",
            ]))

            if not tool_name:
                tn = _extract_xml_tag(all_text, "tool_name")
                if tn:
                    tool_name = tn
                    arguments_from_text = _extract_xml_tag(all_text, "arguments")

            # If BENCHMARK_ACTION is in actions but no tool_name found in XML,
            # try to infer the tool from the thought text
            if not tool_name and "BENCHMARK_ACTION" in response.actions and response.thought:
                # Look for patterns like "call get_order_details" or "use get_order"
                for tool_def in tools_for_context:
                    t_name = str(tool_def.get("name", ""))
                    if t_name and t_name.lower() in response.thought.lower():
                        tool_name = t_name
                        # Try to extract arguments from thought
                        arguments_from_text = _extract_xml_tag(response.thought, "arguments")
                        break

            if tool_name and arguments_from_text and "arguments" not in response.params:
                response.params["arguments"] = arguments_from_text

            if tool_name and isinstance(tool_name, str):
                arguments_raw = response.params.get("arguments", {})
                if isinstance(arguments_raw, str):
                    try:
                        arguments = json.loads(arguments_raw)
                    except json.JSONDecodeError:
                        arguments = {}
                elif isinstance(arguments_raw, dict):
                    arguments = arguments_raw
                else:
                    arguments = {}

                tool_call = ToolCall(tool_name=tool_name, arguments=arguments)
                executed = await self.executor.execute(tool_call)
                tool_calls_made.append(executed)
                last_tool_result = executed.result

                self.conversation.append(
                    ConversationTurn(
                        role="assistant",
                        content=f"Executing tool: {tool_name}",
                        tool_call=executed,
                    )
                )
                self.conversation.append(
                    ConversationTurn(
                        role="tool",
                        content=json.dumps(executed.result, default=str),
                    )
                )
                continue

            # No tool call — this is the final response
            final_response = response.text
            self.conversation.append(
                ConversationTurn(role="assistant", content=final_response)
            )
            break

        return tool_calls_made, final_response, self.conversation

    async def close(self) -> None:
        """No-op — the server manager handles cleanup."""
        pass
