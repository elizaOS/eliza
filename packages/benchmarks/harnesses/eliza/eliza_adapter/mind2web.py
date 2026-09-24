"""Mind2Web agent backed by the eliza benchmark server.

The ``benchmarks.mind2web.types`` import lives outside this package and is
imported lazily so consumers can ``from eliza_adapter.mind2web import
ElizaMind2WebAgent`` without forcing ``benchmarks/`` onto ``sys.path`` at
module-import time. The types are only needed when the agent is actually
constructed or used.
"""

from __future__ import annotations

import asyncio
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

_MIND2WEB_TOOL = {
    "type": "function",
    "function": {
        "name": "MIND2WEB_ACTION",
        "description": "Predict exactly one action from the listed Mind2Web candidates.",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["CLICK", "TYPE", "SELECT", "HOVER", "ENTER"],
                },
                "element_id": {"type": "string"},
                "value": {"type": "string"},
                "reasoning": {"type": "string"},
            },
            "required": ["operation", "element_id"],
            "additionalProperties": False,
        },
    },
}


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
        operation = "INVALID"

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
        self.ranker_recalls: list[float] = []

    async def initialize(self) -> None:
        """Verify the eliza server is reachable."""
        self._client.wait_until_ready(timeout=120)

    async def process_task(self, task: "Mind2WebTask") -> list["Mind2WebAction"]:
        """Process a Mind2Web task and return predicted actions."""
        from benchmarks.mind2web.types import (
            Mind2WebAction,
            Mind2WebOperation,
            Mind2WebRankerMode,
        )

        # Reset session
        self._client.reset(task_id=task.annotation_id, benchmark="mind2web")

        executed_actions: list[Mind2WebAction] = []
        self.ranker_recalls = []
        max_steps = min(self.config.max_steps_per_task, len(task.actions) + 5)

        for step_idx in range(max_steps):
            if step_idx >= len(task.actions):
                break

            current_step = task.actions[step_idx]

            from benchmarks.mind2web.eliza_agent import select_candidates_for_step

            previous_action_reprs = task.action_reprs[:step_idx] if task.action_reprs else []
            all_candidates, ranker_recall = await asyncio.to_thread(
                select_candidates_for_step,
                current_step,
                mode=self.config.ranker_mode,
                task_description=task.confirmed_task,
                previous_actions=previous_action_reprs,
                top_k=self.config.ranker_top_k,
                model_name=self.config.ranker_model,
                revision=self.config.ranker_revision,
                device=self.config.ranker_device,
                task_id=str(task.metadata.get("edge_source_id", task.annotation_id)),
            )
            self.ranker_recalls.append(ranker_recall)
            if (
                self.config.ranker_mode == Mind2WebRankerMode.REAL
                and ranker_recall != 1.0
            ):
                executed_actions.append(
                    Mind2WebAction(
                        operation=Mind2WebOperation.INVALID,
                        reasoning=(
                            "No positive element survived the pinned top-K ranker."
                        ),
                    )
                )
                continue
            from benchmarks.mind2web.eliza_agent import _format_element

            action_surface = _format_element(step_idx, task, all_candidates)
            previous = "\n".join(f"- {action}" for action in previous_action_reprs)
            message_sections = [
                "You are completing a Mind2Web browser task one step at a time.",
                f"Instruction: {task.confirmed_task}",
                f"Website: {task.website}",
                f"Domain: {task.domain}",
                f"Current step: {step_idx + 1} of {len(task.actions)}",
                action_surface,
            ]
            if previous:
                message_sections.append(f"Previous actions:\n{previous}")
            message_sections.append(
                "Return one JSON object only with keys operation, element_id, value, reasoning. "
                "operation must be CLICK, TYPE, SELECT, HOVER, or ENTER. element_id must be a listed "
                "backend_node_id. For TYPE or SELECT, infer the exact value needed to advance the task."
            )
            message_text = "\n\n".join(message_sections)
            elements_for_context = [
                {
                    "backend_node_id": elem.backend_node_id,
                    "tag": elem.tag,
                    "attributes": dict(list(elem.attributes.items())[:5]),
                    "text_content": elem.text_content[:50] if elem.text_content else "",
                }
                for elem in all_candidates
            ]

            # Build context
            context: dict[str, object] = {
                "benchmark": "mind2web",
                "task_id": task.annotation_id,
                "goal": task.confirmed_task,
                "elements": elements_for_context,
                "system_prompt": (
                    "Predict the next Mind2Web browser action from the task, previous actions, "
                    "and ranked candidate elements. Do not assume access to the annotation."
                ),
                "tools": [_MIND2WEB_TOOL],
                "tool_choice": "required",
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Predict the next Mind2Web browser action from the task, previous "
                            "actions, and ranked candidate elements."
                        ),
                    },
                    {"role": "user", "content": message_text},
                ],
            }
            if task.website:
                context["website"] = task.website
            if task.domain:
                context["domain"] = task.domain
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
            mind2web_params = params.get("MIND2WEB_ACTION")
            if isinstance(mind2web_params, dict):
                params = {**params, **mind2web_params}

            action_fields = _coerce_action_fields(params, response.text or "")
            operation_str = action_fields["operation"]
            element_id = action_fields["element_id"]
            value = action_fields["value"]

            if not operation_str:
                operation_str = "INVALID"

            try:
                operation = Mind2WebOperation(operation_str)
            except ValueError:
                operation = Mind2WebOperation.INVALID

            if not element_id:
                logger.warning(
                    "Step %d: native harness returned no element_id; marking action invalid",
                    step_idx,
                )
                element_id = "unknown"
            elif element_id.isdigit():
                candidate_index = int(element_id) - 1
                if 0 <= candidate_index < len(all_candidates):
                    element_id = all_candidates[candidate_index].backend_node_id

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
