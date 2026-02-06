"""LOBSTER_RUN action for running Lobster pipelines."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from elizaos_plugin_lobster.generated.specs import require_action_spec
from elizaos_plugin_lobster.service import LobsterService

logger = logging.getLogger(__name__)

spec = require_action_spec("LOBSTER_RUN")


def extract_xml_value(text: str, tag: str) -> str | None:
    """Extract a value from an XML tag."""
    pattern = rf"<{tag}>(.*?)</{tag}>"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


@dataclass
class LobsterRunAction:
    """Action to run a Lobster pipeline."""

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

        if "lobster run" in lower:
            return True
        if "start lobster" in lower:
            return True
        if "run" in lower and "pipeline" in lower:
            return True
        if "execute pipeline" in lower:
            return True

        return False

    async def handler(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: LobsterService | None = None,
    ) -> dict[str, Any]:
        """Handle the LOBSTER_RUN action."""
        if service is None:
            service = LobsterService()

        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)

        # Extract pipeline and args from message
        # Simple extraction - in production you'd use LLM extraction
        pipeline = self._extract_pipeline(text)
        args_json = extract_xml_value(text, "args") or extract_xml_value(text, "args_json")
        cwd = extract_xml_value(text, "cwd")

        if not pipeline:
            return {
                "success": False,
                "text": "Please specify a pipeline to run. Example: `lobster run deploy-pipeline`",
                "error": "No pipeline specified",
            }

        # Parse args if provided
        args = None
        if args_json:
            try:
                args = json.loads(args_json)
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse args JSON: {args_json}")

        logger.info(f"Running Lobster pipeline: {pipeline}")
        result = await service.run(pipeline, args, cwd)

        if not result.success:
            return {
                "success": False,
                "text": f"Pipeline failed: {result.error}",
                "error": result.error,
            }

        if result.status == "needs_approval" and result.approval:
            return {
                "success": True,
                "text": (
                    f"Pipeline paused for approval.\n\n"
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

        return {
            "success": True,
            "text": "Pipeline completed successfully.",
            "data": {
                "status": "success",
                "outputs": result.outputs,
            },
        }

    def _extract_pipeline(self, text: str) -> str | None:
        """Extract pipeline name from text."""
        # Try XML format first
        pipeline = extract_xml_value(text, "pipeline")
        if pipeline:
            return pipeline

        # Try common patterns
        lower = text.lower()

        # "lobster run <pipeline>"
        match = re.search(r"lobster\s+run\s+([^\s]+)", lower)
        if match:
            return match.group(1)

        # "run <pipeline> pipeline"
        match = re.search(r"run\s+(?:the\s+)?([^\s]+)\s+pipeline", lower)
        if match:
            return match.group(1)

        # "execute <pipeline>"
        match = re.search(r"execute\s+(?:the\s+)?([^\s]+)", lower)
        if match:
            return match.group(1)

        return None
