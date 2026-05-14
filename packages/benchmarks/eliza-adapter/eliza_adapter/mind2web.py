"""Mind2Web agent backed by the eliza benchmark server.

The ``benchmarks.mind2web.types`` import lives outside this package and is
imported lazily so consumers can ``from eliza_adapter.mind2web import
ElizaMind2WebAgent`` without forcing ``benchmarks/`` onto ``sys.path`` at
module-import time. The types are only needed when the agent is actually
constructed or used.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.mind2web.types import (
        Mind2WebAction,
        Mind2WebConfig,
        Mind2WebOperation,
        Mind2WebTask,
    )

logger = logging.getLogger(__name__)


def _format_candidates(candidates: list[object]) -> str:
    lines: list[str] = []
    for idx, elem in enumerate(candidates[:20], start=1):
        backend_node_id = getattr(elem, "backend_node_id", "")
        tag = getattr(elem, "tag", "")
        attrs_raw = getattr(elem, "attributes", {})
        attrs = attrs_raw if isinstance(attrs_raw, dict) else {}
        attr_text = " ".join(f'{key}="{value}"' for key, value in list(attrs.items())[:6])
        text_content = str(getattr(elem, "text_content", "") or "")
        text = f" text={text_content[:80]!r}" if text_content else ""
        lines.append(
            f"{idx}. backend_node_id={backend_node_id} tag={tag} {attr_text}{text}".strip()
        )
    return "\n".join(lines) if lines else "No candidate elements are available."


class ElizaMind2WebAgent:
    """Mind2Web agent backed by the eliza TypeScript agent.

    Drop-in replacement for ``ElizaOSMind2WebAgent`` — same ``process_task``
    interface but routes through the eliza benchmark server.
    """

    def __init__(
        self,
        config: "Mind2WebConfig",
        client: ElizaClient | None = None,
    ) -> None:
        self.config = config
        self._client = client or ElizaClient()

    async def initialize(self) -> None:
        """Verify the eliza server is reachable."""
        self._client.wait_until_ready(timeout=120)

    async def process_task(self, task: "Mind2WebTask") -> list["Mind2WebAction"]:
        """Process a Mind2Web task and return predicted actions."""
        from benchmarks.mind2web.types import Mind2WebAction, Mind2WebOperation

        # Reset session
        self._client.reset(task_id=task.annotation_id, benchmark="mind2web")

        executed_actions: list[Mind2WebAction] = []
        max_steps = min(self.config.max_steps_per_task, len(task.actions) + 5)

        for step_idx in range(max_steps):
            if step_idx >= len(task.actions):
                break

            current_step = task.actions[step_idx]
            all_candidates = current_step.pos_candidates + current_step.neg_candidates
            current_repr = (
                task.action_reprs[step_idx]
                if task.action_reprs and step_idx < len(task.action_reprs)
                else ""
            )
            previous = "\n".join(
                f"- {action.operation.value} element_id={action.element_id} value={action.value!r}"
                for action in executed_actions
            )

            # Build message
            sections = [
                "You are completing a Mind2Web browser task one step at a time.",
                f"Instruction: {task.confirmed_task}",
                f"Website: {task.website}",
                f"Domain: {task.domain}",
                f"Current step: {step_idx + 1} of {len(task.actions)}",
                "Available elements:\n" + _format_candidates(all_candidates),
            ]
            if current_repr:
                sections.append(
                    "Target micro-action for THIS step (do not skip or merge):\n"
                    f"- {current_repr}\n\n"
                    "Pick the operation matching the verb: Click -> CLICK, "
                    "Type -> TYPE, Select -> SELECT, Hover -> HOVER, Press Enter -> ENTER. "
                    "For Type/Select, value must be the literal value from the micro-action."
                )
            if task.action_reprs:
                sections.append(
                    "Full plan (context only):\n"
                    + "\n".join(f"- {item}" for item in task.action_reprs[:8])
                )
            if previous:
                sections.append("Previous actions:\n" + previous)
            sections.append(
                "Return one JSON object only with keys operation, element_id, value, reasoning. "
                "operation must be CLICK, TYPE, SELECT, HOVER, or ENTER. element_id must be a "
                "listed backend_node_id or listed element number."
            )
            message_text = "\n\n".join(sections)

            # Format element candidates for context
            elements_for_context = [
                {
                    "backend_node_id": elem.backend_node_id,
                    "tag": elem.tag,
                    "attributes": dict(list(elem.attributes.items())[:5]),
                    "text_content": elem.text_content[:50] if elem.text_content else "",
                }
                for elem in all_candidates[:15]
            ]

            # Build context
            context: dict[str, object] = {
                "benchmark": "mind2web",
                "task_id": task.annotation_id,
                "system_prompt": (
                    "Predict exactly one Mind2Web browser action. Respond with strict JSON "
                    "only; do not use markdown or prose."
                ),
                "goal": task.confirmed_task,
                "html": current_step.cleaned_html[:3000] if current_step.cleaned_html else "",
                "elements": elements_for_context,
                "current_micro_action": current_repr,
            }
            if task.website:
                context["website"] = task.website
            if task.domain:
                context["domain"] = task.domain
            if task.action_reprs:
                context["action_plan"] = task.action_reprs

            response = self._client.send_message(text=message_text, context=context)

            # Parse the action from response params or XML in text
            import re

            def _xtag(text: str, tag: str) -> str:
                m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
                return m.group(1).strip() if m else ""

            # Try params first, then fall back to XML tags in text. The TS
            # benchmark server may capture multiple BENCHMARK_ACTION calls
            # from one model turn; score the first decisive action instead of
            # silently overwriting it with a later correction/extra action.
            params = response.params
            action_candidates = params.get("BENCHMARK_ACTIONS")
            if isinstance(action_candidates, list):
                for candidate in action_candidates:
                    if isinstance(candidate, dict):
                        params = {**params, **candidate}
                        break
            bench_params = params.get("BENCHMARK_ACTION")
            if isinstance(bench_params, dict):
                params = {**params, **bench_params}
            native_tool_calls = params.get("tool_calls")
            if isinstance(native_tool_calls, list):
                for call in native_tool_calls:
                    if not isinstance(call, dict):
                        continue
                    function = call.get("function")
                    if not isinstance(function, dict):
                        continue
                    arguments = function.get("arguments")
                    if isinstance(arguments, str):
                        try:
                            decoded = json.loads(arguments)
                        except json.JSONDecodeError:
                            decoded = None
                    else:
                        decoded = arguments
                    if isinstance(decoded, dict) and (
                        decoded.get("operation") or decoded.get("element_id")
                    ):
                        params = {**params, **decoded}
                        break

            operation_str = str(params.get("operation", "")).upper()
            element_id = str(params.get("element_id", ""))
            value = str(params.get("value", ""))

            if not operation_str and response.text:
                operation_str = _xtag(response.text, "operation").upper()
            if not element_id and response.text:
                element_id = _xtag(response.text, "element_id")
            if not value and response.text:
                value = _xtag(response.text, "value")
            if response.text and (not element_id or not operation_str):
                try:
                    payload = json.loads(response.text.strip())
                except json.JSONDecodeError:
                    payload = None
                if isinstance(payload, dict):
                    operation_str = operation_str or str(payload.get("operation", "")).upper()
                    element_id = element_id or str(payload.get("element_id", ""))
                    value = value or str(payload.get("value", ""))
                else:
                    import re

                    match = re.search(r"\{[\s\S]*\}", response.text)
                    if match:
                        try:
                            payload = json.loads(match.group(0))
                        except json.JSONDecodeError:
                            payload = None
                        if isinstance(payload, dict):
                            operation_str = operation_str or str(payload.get("operation", "")).upper()
                            element_id = element_id or str(payload.get("element_id", ""))
                            value = value or str(payload.get("value", ""))

            if not operation_str:
                operation_str = "CLICK"

            try:
                operation = Mind2WebOperation(operation_str)
            except ValueError:
                operation = Mind2WebOperation.CLICK

            if element_id.isdigit():
                index = int(element_id) - 1
                if 0 <= index < len(all_candidates):
                    element_id = all_candidates[index].backend_node_id

            if not element_id:
                logger.warning(
                    "Step %d: eliza returned no element_id; marking action invalid",
                    step_idx,
                )
                element_id = "unknown"

            action = Mind2WebAction(
                operation=operation,
                element_id=element_id,
                value=value,
                reasoning=response.thought or "",
            )
            executed_actions.append(action)

        return executed_actions

    async def close(self) -> None:
        """No-op — the server manager handles cleanup."""
        pass
