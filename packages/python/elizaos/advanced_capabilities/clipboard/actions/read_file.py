"""Clipboard read-file action -- read a local text file for the current task.

Returns the file content so the agent can reference it.  Optionally stores the
result in the bounded task clipboard when ``addToClipboard=true``.

Ported from clipboard/actions/read-file.ts.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.task_clipboard_service import create_task_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

MAX_READ_FILE_BYTES = 128 * 1024


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_workdir(message: Memory, state: State | None = None) -> str | None:
    """Extract working directory from message or state."""
    workdir = getattr(message.content, "workdir", None)
    if isinstance(workdir, str) and workdir.strip():
        return workdir.strip()
    if state is not None:
        coding_workspace = getattr(state, "coding_workspace", None) or getattr(
            state, "codingWorkspace", None
        )
        if isinstance(coding_workspace, dict):
            path = coding_workspace.get("path")
            if isinstance(path, str) and path.strip():
                return path.strip()
    return None


def _resolve_file_path(input_path: str, message: Memory, state: State | None = None) -> str:
    """Resolve a file path (absolute or relative to workdir/cwd)."""
    if os.path.isabs(input_path):
        return os.path.normpath(input_path)
    workdir = _extract_workdir(message, state)
    base = workdir or os.getcwd()
    return os.path.normpath(os.path.join(base, input_path))


async def _extract_read_file_input(
    runtime: IAgentRuntime, message: Memory
) -> dict[str, Any] | None:
    """Extract file path and optional line range from message."""
    # Check explicit content attributes
    file_path = (
        getattr(message.content, "filePath", None)
        or getattr(message.content, "file_path", None)
        or getattr(message.content, "path", None)
    )
    if isinstance(file_path, str) and file_path.strip():
        from_line = getattr(message.content, "from", None) or getattr(
            message.content, "from_line", None
        )
        lines = getattr(message.content, "lines", None)
        return {
            "file_path": file_path.strip(),
            "from_line": int(from_line) if from_line is not None else None,
            "lines": int(lines) if lines is not None else None,
        }

    text = (message.content.text if message.content else "") or ""
    if not text.strip():
        return None

    prompt = (
        "Extract the file path and optional line range to read.\n\n"
        f"User message: {text}\n\n"
        "Respond with XML:\n"
        "<response><filePath>relative/or/absolute/path</filePath>"
        "<from>1</from><lines>40</lines></response>"
    )
    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    if not parsed or not isinstance(parsed.get("filePath"), str):
        return None

    fp = str(parsed["filePath"]).strip()
    from_val = parsed.get("from")
    lines_val = parsed.get("lines")
    return {
        "file_path": fp,
        "from_line": int(from_val) if from_val else None,
        "lines": int(lines_val) if lines_val else None,
    }


async def read_file_from_action_input(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    explicit_input: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Read a file and return its content with metadata."""
    inferred: dict[str, Any] | None
    if explicit_input and explicit_input.get("file_path"):
        inferred = explicit_input
    else:
        inferred = await _extract_read_file_input(runtime, message)

    if not inferred:
        raise FileNotFoundError("I couldn't determine which file to read.")

    resolved_path = _resolve_file_path(inferred["file_path"], message, state)
    p = Path(resolved_path)
    if not p.is_file():
        raise FileNotFoundError(f"Not a file: {resolved_path}")

    raw = p.read_bytes()
    if b"\x00" in raw:
        raise ValueError(f"Refusing to read binary file: {resolved_path}")

    text = raw.decode("utf-8", errors="replace")
    from_line = max(1, inferred.get("from_line") or 1)
    lines_count = inferred.get("lines")

    if from_line > 1 or lines_count is not None:
        all_lines = text.split("\n")
        start_idx = from_line - 1
        line_ct = max(1, lines_count or (len(all_lines) - start_idx))
        text = "\n".join(all_lines[start_idx : start_idx + line_ct])

    truncated = len(text.encode("utf-8")) > MAX_READ_FILE_BYTES
    final_content = text[:MAX_READ_FILE_BYTES] if truncated else text

    return {
        "file_path": resolved_path,
        "content": final_content,
        "truncated": truncated,
        "from_line": from_line,
        "lines_read": final_content.count("\n") + 1,
    }


# ---------------------------------------------------------------------------
# Action definition
# ---------------------------------------------------------------------------


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    has_explicit_path = isinstance(
        getattr(message.content, "filePath", None)
        or getattr(message.content, "file_path", None)
        or getattr(message.content, "path", None),
        str,
    )
    if has_explicit_path:
        return True
    text = (message.content.text if message.content else "") or ""
    return bool(re.search(r"(?:read|open|inspect).*(?:file|path)", text, re.IGNORECASE))


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    try:
        result = await read_file_from_action_input(runtime, message, state)

        # Optionally store in task clipboard
        add_to_clipboard = getattr(message.content, "addToClipboard", False) or getattr(
            message.content, "add_to_clipboard", False
        )
        clipboard_msg = ""
        if add_to_clipboard:
            try:
                service = create_task_clipboard_service(runtime)
                from ..types import AddTaskClipboardItemInput

                entity_id = (
                    str(message.entity_id)
                    if hasattr(message, "entity_id") and message.entity_id
                    else None
                )
                item, replaced, snapshot = await service.add_item(
                    AddTaskClipboardItemInput(
                        title=os.path.basename(result["file_path"]),
                        content=result["content"],
                        source_type="file",
                        source_id=result["file_path"],
                        source_label=result["file_path"],
                    ),
                    entity_id=entity_id,
                )
                action_word = "Updated" if replaced else "Added"
                clipboard_msg = (
                    f"{action_word} clipboard item {item.id}: {item.title}\n"
                    f"Clipboard usage: {len(snapshot.items)}/{snapshot.max_items}.\n"
                    "Clear unused clipboard state when it is no longer needed."
                )
            except Exception as exc:
                clipboard_msg = f"Clipboard add skipped: {exc}"

        parts = [
            f"Read file: {result['file_path']}",
            f"Lines: {result['from_line']}-{result['from_line'] + result['lines_read'] - 1}",
        ]
        if result["truncated"]:
            parts.append("(truncated to 128 KB)")
        if clipboard_msg:
            parts.append(clipboard_msg)
        parts.append("")
        parts.append(result["content"])

        response_text = "\n".join(parts)

        if callback:
            await callback(
                Content(
                    text=response_text,
                    actions=["READ_FILE_SUCCESS"],
                )
            )

        return ActionResult(
            text=response_text,
            success=True,
            data=result,
        )
    except Exception as exc:
        error_msg = str(exc)
        logger.error("[ClipboardReadFile] Error: %s", error_msg)
        if callback:
            await callback(
                Content(
                    text=f"Failed to read file: {error_msg}",
                    actions=["READ_FILE_FAILED"],
                )
            )
        return ActionResult(text="Failed to read file", success=False)


read_file_action = Action(
    name="READ_FILE",
    similes=["OPEN_FILE", "LOAD_FILE"],
    description=(
        "Read a local text file for the current task. Returns the file content "
        "so the agent can reference it. Set addToClipboard=true to keep the "
        "read result in bounded task clipboard state."
    ),
    validate=_validate,
    handler=_handler,
    examples=[],
)
