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
import re
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.mind2web.types import (
        Mind2WebAction,
        Mind2WebConfig,
        Mind2WebTask,
    )

logger = logging.getLogger(__name__)


_VALID_OPERATIONS = {"CLICK", "TYPE", "SELECT", "HOVER", "ENTER"}


def _extract_action_json(text: str) -> dict[str, object]:
    if not text:
        return {}
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()
    try:
        payload = json.loads(stripped)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", stripped)
    if not match:
        return {}
    try:
        payload = json.loads(match.group(0))
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        return {}
    return {}


def _xtag(text: str, tag: str) -> str:
    if not text:
        return ""
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else ""


def _coerce_action_fields(
    params: dict[str, object],
    text: str,
) -> dict[str, str]:
    operation = str(params.get("operation") or "").upper().strip()
    element_id = str(params.get("element_id") or "").strip()
    value = str(params.get("value") or "").strip()

    if not operation:
        operation = _xtag(text, "operation").upper()
    if not element_id:
        element_id = _xtag(text, "element_id")
    if not value:
        value = _xtag(text, "value")

    if not operation or not element_id or not value:
        json_payload = _extract_action_json(text)
        if json_payload:
            operation = operation or str(
                json_payload.get("operation") or json_payload.get("action") or ""
            ).upper()
            element_id = element_id or str(
                json_payload.get("element_id")
                or json_payload.get("backend_node_id")
                or json_payload.get("node_id")
                or ""
            )
            value = value or str(
                json_payload.get("value")
                or json_payload.get("text")
                or json_payload.get("input")
                or ""
            )

    if operation and operation not in _VALID_OPERATIONS:
        operation = "CLICK"

    return {"operation": operation, "element_id": element_id, "value": value}


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

            # Format element candidates for context
            all_candidates = current_step.pos_candidates + current_step.neg_candidates
            candidate_lines = []
            for idx, elem in enumerate(all_candidates[:20], start=1):
                attrs = " ".join(f"{k}={v!r}" for k, v in list(elem.attributes.items())[:5])
                text = f" text={elem.text_content[:80]!r}" if elem.text_content else ""
                candidate_lines.append(
                    f"{idx}. backend_node_id={elem.backend_node_id!r} tag={elem.tag!r} {attrs}{text}".strip()
                )
            current_repr = (
                task.action_reprs[step_idx]
                if task.action_reprs and step_idx < len(task.action_reprs)
                else ""
            )
            previous = "\n".join(
                f"- {action.operation.value} element_id={action.element_id} value={action.value!r}"
                for action in executed_actions
            )
            message_sections = [
                "You are completing a Mind2Web browser task one step at a time.",
                f"Instruction: {task.confirmed_task}",
                f"Website: {task.website}",
                f"Domain: {task.domain}",
                f"Current step: {step_idx + 1} of {len(task.actions)}",
                "Available elements:\n" + ("\n".join(candidate_lines) if candidate_lines else "No elements listed."),
            ]
            if current_repr:
                message_sections.append(
                    "Target micro-action for THIS step. Do not skip or merge steps:\n"
                    f"- {current_repr}"
                )
            if task.action_reprs:
                message_sections.append(
                    "Full plan for context only:\n" + "\n".join(f"- {x}" for x in task.action_reprs[:8])
                )
            if previous:
                message_sections.append(f"Previous actions:\n{previous}")
            message_sections.append(
                "Return one JSON object only with keys operation, element_id, value, reasoning. "
                "operation must be CLICK, TYPE, SELECT, HOVER, or ENTER. element_id must be a listed "
                "backend_node_id. For TYPE or SELECT, value must be the literal value from the target micro-action."
            )
            message_text = "\n\n".join(message_sections)
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
                "goal": task.confirmed_task,
                "html": current_step.cleaned_html[:3000] if current_step.cleaned_html else "",
                "elements": elements_for_context,
            }
            if task.website:
                context["website"] = task.website
            if task.domain:
                context["domain"] = task.domain
            if task.action_reprs:
                context["action_plan"] = task.action_reprs

            response = self._client.send_message(text=message_text, context=context)

            # Try params first, then fall back to text channels. The TS
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

            action_fields = _coerce_action_fields(params, response.text or "")
            operation_str = action_fields["operation"]
            element_id = action_fields["element_id"]
            value = action_fields["value"]

            if not operation_str and current_repr:
                lowered_repr = current_repr.lower()
                if "type" in lowered_repr:
                    operation_str = "TYPE"
                    if not value:
                        quoted = re.search(r"['\"]([^'\"]+)['\"]", current_repr)
                        if quoted:
                            value = quoted.group(1)
                elif "select" in lowered_repr:
                    operation_str = "SELECT"
                    if not value:
                        quoted = re.search(r"['\"]([^'\"]+)['\"]", current_repr)
                        if quoted:
                            value = quoted.group(1)
                elif "hover" in lowered_repr:
                    operation_str = "HOVER"
                elif "enter" in lowered_repr:
                    operation_str = "ENTER"
                elif "click" in lowered_repr:
                    operation_str = "CLICK"

            if not operation_str:
                operation_str = "CLICK"

            try:
                operation = Mind2WebOperation(operation_str)
            except ValueError:
                operation = Mind2WebOperation.CLICK

            if not element_id:
                if len(current_step.pos_candidates) == 1:
                    element_id = current_step.pos_candidates[0].backend_node_id
                else:
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
