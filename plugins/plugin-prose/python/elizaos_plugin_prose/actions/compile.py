"""PROSE_COMPILE action for validating OpenProse programs."""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

from elizaos_plugin_prose.generated.specs import require_action_spec
from elizaos_plugin_prose.services.prose_service import ProseService

logger = logging.getLogger(__name__)

spec = require_action_spec("PROSE_COMPILE")


def extract_xml_value(text: str, tag: str) -> str | None:
    """Extract a value from an XML tag."""
    pattern = rf"<{tag}>(.*?)</{tag}>"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


def parse_list(text: str | None) -> list[str]:
    """Parse a list from text (lines starting with -)."""
    if not text:
        return []
    return [
        line.lstrip("- ").strip()
        for line in text.split("\n")
        if line.strip().startswith("-")
    ]


@dataclass
class ProseCompileAction:
    """Action to validate an OpenProse program."""

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

        if "prose compile" in lower:
            return True
        if "prose validate" in lower:
            return True
        if "check" in lower and ".prose" in lower:
            return True
        if "validate" in lower and ".prose" in lower:
            return True

        return False

    async def handler(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: ProseService | None = None,
    ) -> dict[str, Any]:
        """Handle the PROSE_COMPILE action."""
        if service is None:
            service = ProseService()

        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)

        # Extract file path
        file = self._extract_file(text)

        if not file:
            return {
                "success": False,
                "text": "Please specify a .prose file to validate. Example: `prose compile workflow.prose`",
                "error": "No file specified",
            }

        file_path = file if os.path.isabs(file) else os.path.join(os.getcwd(), file)

        # Check if file exists
        exists = await service.file_exists(file_path)
        if not exists:
            return {
                "success": False,
                "text": f"File not found: {file_path}",
                "error": "File not found",
            }

        # Read the program
        program_content = await service.read_prose_file(file_path)

        # Perform basic validation (in production, use LLM)
        result = self._basic_validate(program_content)

        logger.info(f"Validated {file}: valid={result['valid']}")

        # Build response
        parts: list[str] = []
        parts.append(f"## Validation Results for {file}\n")
        parts.append(f"**Status:** {'✓ Valid' if result['valid'] else '✗ Invalid'}\n")
        parts.append(f"**Summary:** {result['summary']}\n")

        if result["errors"]:
            parts.append("\n### Errors\n")
            for error in result["errors"]:
                parts.append(f"- ❌ {error}")

        if result["warnings"]:
            parts.append("\n### Warnings\n")
            for warning in result["warnings"]:
                parts.append(f"- ⚠️ {warning}")

        if result["valid"] and not result["errors"] and not result["warnings"]:
            parts.append("\nNo issues found. Program is ready to run.")

        return {
            "success": True,
            "text": "\n".join(parts),
            "data": {
                "valid": result["valid"],
                "errors": result["errors"],
                "warnings": result["warnings"],
                "file": file,
            },
        }

    def _extract_file(self, text: str) -> str | None:
        """Extract file path from text."""
        # Try XML format first
        file = extract_xml_value(text, "file")
        if file:
            return file

        lower = text.lower()

        # "prose compile <file>" or "prose validate <file>"
        match = re.search(r"prose\s+(?:compile|validate)\s+([^\s]+)", lower)
        if match:
            return match.group(1)

        # "check <file.prose>" or "validate <file.prose>"
        match = re.search(r"(?:check|validate)\s+([^\s]+\.prose)", lower)
        if match:
            return match.group(1)

        return None

    def _basic_validate(self, content: str) -> dict[str, Any]:
        """Perform basic validation on prose content."""
        errors: list[str] = []
        warnings: list[str] = []

        # Check for program block
        if "program" not in content.lower():
            errors.append("Missing program declaration")

        # Check for balanced braces
        open_braces = content.count("{")
        close_braces = content.count("}")
        if open_braces != close_braces:
            errors.append(f"Unbalanced braces: {open_braces} open, {close_braces} close")

        # Check for session definition
        if "session" not in content.lower():
            warnings.append("No session defined - program may not have an entry point")

        # Check for version
        if "version" not in content.lower():
            warnings.append("No version specified")

        valid = len(errors) == 0
        summary = "Program is syntactically correct." if valid else "Program has validation errors."

        return {
            "valid": valid,
            "errors": errors,
            "warnings": warnings,
            "summary": summary,
        }
