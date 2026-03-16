"""PROSE_RUN action for running OpenProse programs."""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from elizaos_plugin_prose.generated.specs import require_action_spec
from elizaos_plugin_prose.services.prose_service import ProseService
from elizaos_plugin_prose.types import ProseStateMode

logger = logging.getLogger(__name__)

spec = require_action_spec("PROSE_RUN")


def extract_xml_value(text: str, tag: str) -> str | None:
    """Extract a value from an XML tag."""
    pattern = rf"<{tag}>(.*?)</{tag}>"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


def build_execution_context(
    service: ProseService,
    program_content: str,
    run_id: str,
    run_dir: str,
    state_mode: ProseStateMode,
    inputs: dict[str, Any] | None,
) -> str:
    """Build the execution context for a prose run."""
    parts: list[str] = []

    # VM loading banner
    parts.append(
        f"""╔══════════════════════════════════════════════════════════════╗
║                    OpenProse VM Loading                       ║
╚══════════════════════════════════════════════════════════════╝

Run ID: {run_id}
Run Directory: {run_dir}
State Mode: {state_mode.value}
"""
    )

    # VM specification
    vm_context = service.build_vm_context(
        state_mode=state_mode,
        include_compiler=False,
        include_guidance=False,
    )
    parts.append(vm_context)

    # The program to execute
    parts.append(
        f"""
═══════════════════════════════════════════════════════════════
                      PROGRAM TO EXECUTE
═══════════════════════════════════════════════════════════════

```prose
{program_content}
```
"""
    )

    # Inputs if provided
    if inputs:
        parts.append(
            f"""
═══════════════════════════════════════════════════════════════
                        PROGRAM INPUTS
═══════════════════════════════════════════════════════════════

```json
{json.dumps(inputs, indent=2)}
```
"""
        )

    # Execution instructions
    parts.append(
        f"""
═══════════════════════════════════════════════════════════════
                    EXECUTION INSTRUCTIONS
═══════════════════════════════════════════════════════════════

You are now the OpenProse VM. Your task is to execute the program above
by interpreting each statement according to the VM specification.

1. Parse the program structure (definitions, sessions, control flow)
2. Execute statements in order, using the Task tool for sessions
3. Maintain state in {run_dir} according to {state_mode.value} mode
4. Report progress and results back to the user

Begin execution now.
"""
    )

    return "\n".join(parts)


@dataclass
class ProseRunAction:
    """Action to run an OpenProse program."""

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

        if "prose run" in lower:
            return True
        if "run" in lower and ".prose" in lower:
            return True
        if "execute" in lower and ".prose" in lower:
            return True
        if re.search(r"run\s+[\w./\-]+\.prose", lower):
            return True

        return False

    async def handler(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: ProseService | None = None,
    ) -> dict[str, Any]:
        """Handle the PROSE_RUN action."""
        if service is None:
            service = ProseService()

        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)

        # Extract parameters
        file = self._extract_file(text)
        state_mode_str = extract_xml_value(text, "state_mode")
        inputs_json = extract_xml_value(text, "inputs_json")
        cwd = extract_xml_value(text, "cwd") or os.getcwd()

        if not file:
            return {
                "success": False,
                "text": "Please specify a .prose file to run. Example: `prose run workflow.prose`",
                "error": "No file specified",
            }

        state_mode = ProseStateMode.FILESYSTEM
        if state_mode_str:
            try:
                state_mode = ProseStateMode(state_mode_str)
            except ValueError:
                pass

        # Parse inputs
        inputs = None
        if inputs_json:
            try:
                inputs = json.loads(inputs_json)
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse inputs_json: {inputs_json}")

        # Resolve file path
        file_path = file if os.path.isabs(file) else os.path.join(cwd, file)

        # Check if file exists
        exists = await service.file_exists(file_path)
        if not exists:
            # Check if it's an example reference
            if file.startswith("examples/") or "/" not in file:
                example_name = file.replace("examples/", "")
                example_content = await service.read_example(example_name)
                if example_content:
                    workspace_dir = await service.ensure_workspace(cwd)
                    run_id, run_dir = await service.create_run_directory(
                        workspace_dir, example_content
                    )

                    exec_context = build_execution_context(
                        service, example_content, run_id, run_dir, state_mode, inputs
                    )

                    return {
                        "success": True,
                        "text": f"Loading OpenProse VM for example: {example_name}\n\nRun ID: {run_id}\n\n{exec_context}",
                        "data": {
                            "runId": run_id,
                            "runDir": run_dir,
                            "stateMode": state_mode.value,
                            "file": example_name,
                        },
                    }

            return {
                "success": False,
                "text": f"File not found: {file_path}\n\nUse `prose examples` to see available example programs.",
                "error": "File not found",
            }

        # Read the program
        program_content = await service.read_prose_file(file_path)

        # Set up workspace and run directory
        workspace_dir = await service.ensure_workspace(cwd)
        run_id, run_dir = await service.create_run_directory(workspace_dir, program_content)

        logger.info(f"Starting prose run {run_id} for {file}")

        # Build the execution context
        exec_context = build_execution_context(
            service, program_content, run_id, run_dir, state_mode, inputs
        )

        return {
            "success": True,
            "text": f"Loading OpenProse VM...\n\nRun ID: {run_id}\nProgram: {file}\nState Mode: {state_mode.value}\n\n{exec_context}",
            "data": {
                "runId": run_id,
                "runDir": run_dir,
                "stateMode": state_mode.value,
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

        # "prose run <file>"
        match = re.search(r"prose\s+run\s+([^\s]+)", lower)
        if match:
            return match.group(1)

        # "run <file.prose>"
        match = re.search(r"run\s+([^\s]+\.prose)", lower)
        if match:
            return match.group(1)

        # "execute <file.prose>"
        match = re.search(r"execute\s+([^\s]+\.prose)", lower)
        if match:
            return match.group(1)

        return None
