"""Tau-bench agent backed by the OpenClaw CLI.

Drop-in equivalent of :class:`eliza_adapter.tau_bench.ElizaTauAgent` but
routes per-turn decision-making through :class:`OpenClawClient`. Same
``process_task(task) -> (tool_calls, final_response, conversation)``
interface as the eliza adapter.

OpenClaw runs as a stateless CLI per spawn, so the conversation is
threaded into the user-side prompt each turn. The audit notes OpenClaw
does not reliably honor ``tool_choice='required'``; the adapter accepts
either OpenAI-shape ``params['tool_calls']`` or a JSON-blob ``tool_name``
/ ``arguments`` field embedded in the response text.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Any

from openclaw_adapter.client import OpenClawClient

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

_FINAL_TAG_RE = re.compile(r"<final>(.*?)</final>", re.DOTALL | re.IGNORECASE)
_TOOL_CALL_JSON_RE = re.compile(
    r"\{\s*\"tool_name\"\s*:\s*\"[^\"]+\"\s*,\s*\"arguments\"\s*:\s*[\[\{].*?\}",
    re.DOTALL,
)


def _tool_to_openai_spec(tool: Any) -> dict[str, Any]:
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


def _extract_tool_call_from_text(text: str) -> dict[str, Any] | None:
    """Last-resort: look for an inline ``{"tool_name": ..., "arguments": ...}``."""
    if not text:
        return None
    match = _TOOL_CALL_JSON_RE.search(text)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("tool_name")
    if not isinstance(name, str) or not name.strip():
        return None
    return {
        "id": "inline_0",
        "name": name.strip(),
        "arguments": parsed.get("arguments", {}),
    }


class OpenClawTauAgent:
    """Tau-bench agent that delegates to OpenClaw for tool-call decisions.

    Drop-in replacement for :class:`eliza_adapter.tau_bench.ElizaTauAgent` —
    same ``process_task`` interface, same return shape.
    """

    def __init__(
        self,
        executor: "ToolExecutor",
        max_turns: int = 15,
        client: OpenClawClient | None = None,
        system_prompt: str | None = None,
    ) -> None:
        self.executor = executor
        self.max_turns = max_turns
        self._client = client or OpenClawClient()
        self._system_prompt = system_prompt

    async def initialize(self) -> None:
        return None

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
            logger.debug("openclaw reset failed (continuing): %s", exc)

        tools_spec = [_tool_to_openai_spec(t) for t in task.available_tools]

        # OpenClaw is stateless — render the transcript into the prompt
        # explicitly each turn.
        history_lines: list[str] = []
        system_chunks: list[str] = []
        if self._system_prompt:
            system_chunks.append(self._system_prompt)
        if task.policy_constraints:
            policy_dump = json.dumps(
                [
                    {"policy_id": p.policy_id, "description": p.description}
                    for p in task.policy_constraints
                ],
                ensure_ascii=True,
            )
            system_chunks.append(f"Policies:\n{policy_dump}")
        if task.user_profile:
            system_chunks.append(f"User profile:\n{json.dumps(task.user_profile)}")
        system_chunks.append(
            "When you need to call a tool, return a JSON object on its own "
            "line: {\"tool_name\": \"<name>\", \"arguments\": {...}}. When you "
            "have a final answer, wrap it in <final>...</final>."
        )
        system_prompt = "\n\n".join(system_chunks)

        for msg in task.conversation_history:
            history_lines.append(f"[{msg['role'].upper()}]\n{msg['content']}")
            conversation.append(ConversationTurn(role=msg["role"], content=msg["content"]))
        history_lines.append(f"[USER]\n{task.user_instruction}")
        conversation.append(
            ConversationTurn(role="user", content=task.user_instruction)
        )

        for _turn_idx in range(self.max_turns):
            prompt = "\n\n".join(history_lines) + "\n\n[ASSISTANT]"

            context: dict[str, object] = {
                "benchmark": "tau_bench",
                "task_id": task.task_id,
                "system_prompt": system_prompt,
                "tools": tools_spec,
                "_stateless": True,
            }
            if task.user_goal:
                context["goal"] = task.user_goal
            if task.success_criteria:
                context["success_criteria"] = task.success_criteria

            response = self._client.send_message(text=prompt, context=context)
            text = response.text or ""

            # 1. Prefer structured tool_calls if the CLI surfaced them.
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
                            "arguments": entry.get("arguments", {}),
                        }
                    )

            # 2. Fallback: inline JSON tool call in the response text.
            if not normalized:
                inline = _extract_tool_call_from_text(text)
                if inline is not None:
                    normalized.append(inline)

            if not normalized:
                # 3. <final>...</final> envelope, else raw text.
                m = _FINAL_TAG_RE.search(text)
                final_response = m.group(1).strip() if m else text
                conversation.append(
                    ConversationTurn(role="assistant", content=final_response)
                )
                break

            history_lines.append(f"[ASSISTANT]\n{text}")

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
                history_lines.append(
                    f"[TOOL_RESULT {nc['name']}]\n{result_str[:2000]}"
                )

        return tool_calls_made, final_response, conversation

    async def close(self) -> None:
        return None


def build_tau_bench_agent_fn(
    *,
    executor: "ToolExecutor",
    client: OpenClawClient | None = None,
    max_turns: int = 15,
    system_prompt: str | None = None,
) -> OpenClawTauAgent:
    """Factory matching the ``build_<bench>_agent_fn`` shape of the BFCL adapter."""
    return OpenClawTauAgent(
        executor=executor,
        max_turns=max_turns,
        client=client,
        system_prompt=system_prompt,
    )


__all__ = [
    "OpenClawTauAgent",
    "build_tau_bench_agent_fn",
]
