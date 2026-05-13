"""Tau-bench agent backed by hermes-agent.

Drop-in equivalent of :class:`eliza_adapter.tau_bench.ElizaTauAgent` but
routes per-turn decision-making through :class:`HermesClient`. Tau-bench's
runner uses ``process_task(task) -> (tool_calls, final_response, conversation)``
so this agent matches that signature exactly.

Key difference vs the eliza version: hermes-agent natively speaks the
OpenAI tool-call shape, so the adapter passes the task's available tools
in as OpenAI-format function specs and reads ``params['tool_calls']``
directly rather than parsing assistant message text.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from hermes_adapter.client import HermesClient

if TYPE_CHECKING:
    from elizaos_tau_bench.executor import ToolExecutor
    from elizaos_tau_bench.types import (
        ConversationTurn,
        TauBenchTask,
        ToolCall,
    )


def _tau_types():
    from elizaos_tau_bench.types import (
        ConversationTurn,
        TauBenchTask,
        ToolCall,
    )

    return ConversationTurn, TauBenchTask, ToolCall


logger = logging.getLogger(__name__)


def _tool_to_openai_spec(tool: Any) -> dict[str, Any]:
    """Convert a Tau-bench ``ToolDefinition`` to an OpenAI ``function`` spec."""
    return {
        "type": "function",
        "function": {
            "name": getattr(tool, "name", ""),
            "description": getattr(tool, "description", "") or "",
            "parameters": getattr(tool, "parameters", {}) or {"type": "object", "properties": {}},
        },
    }


def _parse_arguments(arguments_raw: Any) -> dict[str, Any]:
    if isinstance(arguments_raw, dict):
        return dict(arguments_raw)
    if isinstance(arguments_raw, str):
        try:
            parsed = json.loads(arguments_raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    return {}


class HermesTauAgent:
    """Tau-bench agent that delegates to hermes-agent for tool-call decisions.

    Drop-in replacement for :class:`eliza_adapter.tau_bench.ElizaTauAgent` —
    same ``process_task`` interface, same return shape.
    """

    def __init__(
        self,
        executor: "ToolExecutor",
        max_turns: int = 15,
        client: HermesClient | None = None,
        system_prompt: str | None = None,
    ) -> None:
        self.executor = executor
        self.max_turns = max_turns
        self._client = client or HermesClient()
        self._system_prompt = system_prompt

    async def initialize(self) -> None:
        self._client.wait_until_ready(timeout=120)

    async def process_task(
        self,
        task: "TauBenchTask",
    ) -> tuple[list["ToolCall"], str, list["ConversationTurn"]]:
        ConversationTurn, _, ToolCall = _tau_types()

        conversation: list[ConversationTurn] = []
        tool_calls_made: list[ToolCall] = []
        final_response = ""

        try:
            self._client.reset(task_id=task.task_id, benchmark="tau_bench")
        except Exception as exc:  # noqa: BLE001
            logger.debug("hermes reset failed (continuing): %s", exc)

        tools_spec = [_tool_to_openai_spec(t) for t in task.available_tools]

        # Build the OpenAI-shape message history. Tau-bench's ``task`` carries
        # a pre-existing ``conversation_history`` plus a new user instruction.
        messages: list[dict[str, Any]] = []
        system_lines: list[str] = []
        if self._system_prompt:
            system_lines.append(self._system_prompt)
        if task.policy_constraints:
            policy_dump = json.dumps(
                [
                    {"policy_id": p.policy_id, "description": p.description}
                    for p in task.policy_constraints
                ],
                ensure_ascii=True,
            )
            system_lines.append(f"Policies:\n{policy_dump}")
        if task.user_profile:
            system_lines.append(f"User profile:\n{json.dumps(task.user_profile)}")
        if system_lines:
            messages.append({"role": "system", "content": "\n\n".join(system_lines)})

        for msg in task.conversation_history:
            messages.append({"role": msg["role"], "content": msg["content"]})
            conversation.append(ConversationTurn(role=msg["role"], content=msg["content"]))

        messages.append({"role": "user", "content": task.user_instruction})
        conversation.append(
            ConversationTurn(role="user", content=task.user_instruction)
        )

        for _turn_idx in range(self.max_turns):
            context: dict[str, object] = {
                "benchmark": "tau_bench",
                "task_id": task.task_id,
                "messages": list(messages),
                "tools": tools_spec,
                "tool_choice": "auto",
                "_stateless": True,
            }
            if task.user_goal:
                context["goal"] = task.user_goal
            if task.success_criteria:
                context["success_criteria"] = task.success_criteria

            response = self._client.send_message(text=task.user_instruction, context=context)
            raw_calls = (
                response.params.get("tool_calls") if isinstance(response.params, dict) else None
            )
            normalized: list[dict[str, Any]] = []
            if isinstance(raw_calls, list):
                for entry in raw_calls:
                    if not isinstance(entry, dict):
                        continue
                    name = str(entry.get("name") or "").strip()
                    if not name:
                        continue
                    normalized.append(
                        {
                            "id": str(entry.get("id") or f"call_{len(normalized)}"),
                            "name": name,
                            "arguments": entry.get("arguments", "{}"),
                        }
                    )

            if not normalized:
                # No tool call → treat as final response.
                final_response = response.text or ""
                conversation.append(
                    ConversationTurn(role="assistant", content=final_response)
                )
                break

            # Record assistant tool_calls in the message history.
            assistant_tool_calls: list[dict[str, Any]] = []
            for nc in normalized:
                args = nc["arguments"]
                if isinstance(args, dict):
                    args_str = json.dumps(args)
                else:
                    args_str = str(args)
                assistant_tool_calls.append(
                    {
                        "id": nc["id"],
                        "type": "function",
                        "function": {"name": nc["name"], "arguments": args_str},
                    }
                )
            messages.append(
                {
                    "role": "assistant",
                    "content": response.text or None,
                    "tool_calls": assistant_tool_calls,
                }
            )

            # Execute each tool call and feed results back as tool messages.
            for nc in normalized:
                arguments = _parse_arguments(nc["arguments"])
                tool_call = ToolCall(tool_name=nc["name"], arguments=arguments)
                executed = await self.executor.execute(tool_call)
                tool_calls_made.append(executed)

                conversation.append(
                    ConversationTurn(
                        role="assistant",
                        content=f"Executing tool: {nc['name']}",
                        tool_call=executed,
                    )
                )
                result_str = json.dumps(executed.result, default=str)
                conversation.append(
                    ConversationTurn(role="tool", content=result_str)
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": nc["id"],
                        "name": nc["name"],
                        "content": result_str[:4000],
                    }
                )
        else:
            # Loop exhausted without a final non-tool response.
            final_response = response.text or final_response

        return tool_calls_made, final_response, conversation

    async def close(self) -> None:
        return None


def build_tau_bench_agent_fn(
    *,
    executor: "ToolExecutor",
    client: HermesClient | None = None,
    max_turns: int = 15,
    system_prompt: str | None = None,
) -> HermesTauAgent:
    """Factory matching the ``build_<bench>_agent_fn`` shape of the BFCL adapter."""
    return HermesTauAgent(
        executor=executor,
        max_turns=max_turns,
        client=client,
        system_prompt=system_prompt,
    )


__all__ = [
    "HermesTauAgent",
    "build_tau_bench_agent_fn",
]
