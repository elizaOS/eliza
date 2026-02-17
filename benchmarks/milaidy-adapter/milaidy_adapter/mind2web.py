"""Mind2Web agent backed by the milaidy benchmark server."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from milaidy_adapter.client import MilaidyClient

from benchmarks.mind2web.types import (
    Mind2WebAction,
    Mind2WebConfig,
    Mind2WebOperation,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)


class MilaidyMind2WebAgent:
    """Mind2Web agent backed by the milaidy TypeScript agent.

    Drop-in replacement for ``elizaOSMind2WebAgent`` — same ``process_task``
    interface but routes through the milaidy benchmark server.
    """

    def __init__(
        self,
        config: Mind2WebConfig,
        client: MilaidyClient | None = None,
    ) -> None:
        self.config = config
        self._client = client or MilaidyClient()

    async def initialize(self) -> None:
        """Verify the milaidy server is reachable."""
        self._client.wait_until_ready(timeout=120)

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        """Process a Mind2Web task and return predicted actions."""
        # Reset session
        self._client.reset(task_id=task.annotation_id, benchmark="mind2web")

        executed_actions: list[Mind2WebAction] = []
        max_steps = min(self.config.max_steps_per_task, len(task.actions) + 5)

        for step_idx in range(max_steps):
            if step_idx >= len(task.actions):
                break

            current_step = task.actions[step_idx]

            # Build message
            if step_idx == 0:
                message_text = (
                    f"Complete this web task: {task.confirmed_task}\n\n"
                    "Analyze the available elements and execute the first action."
                )
            else:
                message_text = (
                    f"Step {step_idx + 1}/{len(task.actions)}: Continue with the next action.\n"
                    "Analyze the available elements and execute the correct action."
                )

            # Format element candidates for context
            all_candidates = current_step.pos_candidates + current_step.neg_candidates
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

            # Parse the action from response params
            operation_str = str(response.params.get("operation", "CLICK")).upper()
            try:
                operation = Mind2WebOperation(operation_str)
            except ValueError:
                operation = Mind2WebOperation.CLICK

            element_id = str(response.params.get("element_id", ""))
            value = str(response.params.get("value", ""))

            if not element_id:
                logger.warning(
                    "Step %d: milaidy returned no element_id, using first positive candidate",
                    step_idx,
                )
                if current_step.pos_candidates:
                    element_id = current_step.pos_candidates[0].backend_node_id
                else:
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
