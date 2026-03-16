"""LOBSTER_RESUME action for resuming paused pipelines."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from elizaos_plugin_lobster.generated.specs import require_action_spec
from elizaos_plugin_lobster.service import LobsterService

logger = logging.getLogger(__name__)

spec = require_action_spec("LOBSTER_RESUME")


@dataclass
class LobsterResumeAction:
    """Action to resume a paused Lobster pipeline."""

    name: str = spec.name
    description: str = spec.description
    similes: list[str] = None  # type: ignore
    examples: list[list[dict[str, str]]] = None  # type: ignore

    def __post_init__(self) -> None:
        self.similes = spec.similes
        self.examples = spec.examples

    async def validate(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
    ) -> bool:
        """Validate if this action should be triggered."""
        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)
        lower = text.lower()

        # Check for pending token in state
        pending_token = (state or {}).get("pendingLobsterToken")
        if pending_token:
            # Any approval/rejection response
            if any(
                word in lower
                for word in ["approve", "yes", "continue", "reject", "no", "cancel"]
            ):
                return True

        # Explicit resume command
        if "lobster resume" in lower:
            return True
        if "resume" in lower and "pipeline" in lower:
            return True

        return False

    async def handler(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: LobsterService | None = None,
    ) -> dict[str, Any]:
        """Handle the LOBSTER_RESUME action."""
        if service is None:
            service = LobsterService()

        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)
        lower = text.lower()

        # Get token from state or message
        token = None
        if state:
            token = state.get("pendingLobsterToken")

        if not token:
            # Try to extract from message
            match = re.search(r"resume\s+([^\s]+)", lower)
            if match:
                token = match.group(1)

        if not token:
            return {
                "success": False,
                "text": "No pending pipeline to resume. Please provide a resume token.",
                "error": "No token available",
            }

        # Determine approval/rejection
        approve = self._determine_approval(lower)

        logger.info(f"Resuming Lobster pipeline with token: {token}, approve: {approve}")
        result = await service.resume(token, approve)

        if not result.success:
            return {
                "success": False,
                "text": f"Failed to resume pipeline: {result.error}",
                "error": result.error,
            }

        if result.status == "needs_approval" and result.approval:
            # Another approval checkpoint
            return {
                "success": True,
                "text": (
                    f"Pipeline reached another approval checkpoint.\n\n"
                    f"**Step:** {result.approval.step_name}\n"
                    f"**Description:** {result.approval.description}\n\n"
                    f"Reply with 'approve' or 'reject' to continue."
                ),
                "data": {
                    "status": "needs_approval",
                    "resumeToken": result.approval.resume_token,
                    "stepName": result.approval.step_name,
                },
            }

        action_word = "approved" if approve else "rejected"
        return {
            "success": True,
            "text": f"Pipeline {action_word} and completed successfully.",
            "data": {
                "status": "success",
                "outputs": result.outputs,
            },
        }

    def _determine_approval(self, text: str) -> bool:
        """Determine if the user wants to approve or reject."""
        rejection_words = ["no", "reject", "cancel", "deny", "stop", "abort"]
        for word in rejection_words:
            if word in text:
                return False
        return True
