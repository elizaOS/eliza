"""
Agent providers for orchestrated SWE-bench benchmark.

Implements AgentProvider for:
- Claude Code (Anthropic API with tool use)
- SWE-Agent (ElizaOS agent loop methodology)
- Eliza Code (full ElizaOS message pipeline)

Each provider receives an OrchestratedTask from the orchestrator and
uses the SWE-bench repo tools to solve the issue.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import logging
import os
import re
import textwrap
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from elizaos_plugin_agent_orchestrator import (
    AgentProviderId,
    OrchestratedTask,
    ProviderTaskExecutionContext,
    TaskResult,
)

from ..repo_manager import RepositoryManager

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


# ============================================================================
# Base provider with shared repo tool logic
# ============================================================================


class BaseSWEBenchProvider:
    """Shared functionality for all SWE-bench providers."""

    def __init__(
        self,
        repo_manager: RepositoryManager,
        max_steps: int = 30,
        trace_hook: Callable[[str, str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> None:
        self.repo_manager = repo_manager
        self.max_steps = max_steps
        self._trace_hook = trace_hook

    def set_trace_hook(
        self,
        hook: Callable[[str, str, dict[str, object]], Awaitable[None]] | None,
    ) -> None:
        self._trace_hook = hook

    async def _trace(self, actor: str, event: str, data: dict[str, object]) -> None:
        if self._trace_hook is None:
            return
        await self._trace_hook(actor, event, data)

    @property
    def description(self) -> str | None:
        return None

    @property
    def capabilities(self) -> list[str]:
        return [
            "code.read",
            "code.write",
            "code.edit",
            "code.search",
            "code.shell",
        ]

    async def _execute_tool(
        self,
        tool_name: str,
        params: dict[str, str | int | float | bool | None],
        _ctx: ProviderTaskExecutionContext,
    ) -> tuple[bool, str]:
        """Execute a SWE-bench tool via the repo manager.

        Maps tool names to the actual RepositoryManager API:
        - SEARCH_CODE -> repo_manager.search_code(query, file_pattern)
        - READ_FILE -> repo_manager.read_file(file_path) + optional line slicing
        - EDIT_FILE -> repo_manager.read_file() + replace + write_file()
        - LIST_FILES -> repo_manager.get_file_tree() / get_python_files()
        - SHELL -> subprocess execution in repository workspace
        - SUBMIT -> repo_manager.get_diff()
        """
        name = tool_name.upper()

        def _sanitize_single_line(value: object) -> str:
            """Take the first non-empty line from model-provided scalar params."""
            raw = str(value)
            for line in raw.splitlines():
                stripped = line.strip()
                if stripped:
                    return stripped
            return raw.strip()

        if name == "SEARCH_CODE":
            query = _sanitize_single_line(params.get("query", ""))
            if not query:
                return False, "ValidationError: query is required for SEARCH_CODE"
            file_pattern = _sanitize_single_line(params.get("file_pattern", "*.py"))
            if not file_pattern:
                file_pattern = "*.py"
            results = await self.repo_manager.search_code(query, file_pattern)
            # Some grep include patterns (e.g. full paths) may not match as expected.
            # Fall back to a broader Python search before declaring no matches.
            if not results and file_pattern not in ("", "*.py", "python"):
                results = await self.repo_manager.search_code(query, "*.py")

            # If a specific file was requested and grep still found nothing,
            # perform a direct line-by-line substring scan on that file.
            if not results and "/" in file_pattern and "*" not in file_pattern:
                content = await self.repo_manager.read_file(file_pattern)
                if content is not None:
                    direct_matches: list[str] = []
                    for idx, line in enumerate(content.split("\n"), start=1):
                        if query in line:
                            direct_matches.append(
                                f"  {file_pattern}:{idx}: {line[:120]}"
                            )
                        if len(direct_matches) >= 20:
                            break
                    if direct_matches:
                        return True, (
                            f"Found {len(direct_matches)} matches "
                            f"(direct scan in {file_pattern}):\n"
                            + "\n".join(direct_matches)
                        )

            if not results:
                return True, "No matches found."
            lines = [f"Found {len(results)} matches:"]
            for m in results[:20]:
                lines.append(f"  {m.file_path}:{m.start_line}: {m.content[:120]}")
            return True, "\n".join(lines)

        if name == "READ_FILE":
            file_path = _sanitize_single_line(params.get("file_path", ""))
            if not file_path:
                return False, "ValidationError: file_path is required for READ_FILE"
            content = await self.repo_manager.read_file(file_path)
            if content is None:
                return False, f"File not found: {file_path}"

            start_line = params.get("start_line")
            end_line = params.get("end_line")
            if start_line is not None and end_line is not None:
                try:
                    start_num = int(start_line)
                    end_num = int(end_line)
                except (TypeError, ValueError):
                    return False, "ValidationError: start_line and end_line must be integers"
                if start_num < 1:
                    return False, "ValidationError: start_line must be >= 1"
                if end_num < start_num:
                    return False, "ValidationError: end_line must be >= start_line"

                all_lines = content.split("\n")
                start_idx = max(0, start_num - 1)
                end_idx = min(len(all_lines), end_num)
                selected = all_lines[start_idx:end_idx]
                numbered = [
                    f"{i + start_idx + 1:4d} | {line}"
                    for i, line in enumerate(selected)
                ]
                return True, "\n".join(numbered)

            return True, content

        if name == "EDIT_FILE":
            file_path = _sanitize_single_line(params.get("file_path", ""))
            if not file_path:
                return False, "ValidationError: file_path is required for EDIT_FILE"
            old_value = params.get("old_str", params.get("old_content"))
            new_value = params.get("new_str", params.get("new_content"))
            if new_value is None:
                return False, "ValidationError: new_str is required for EDIT_FILE"

            old_str = "" if old_value is None else str(old_value)
            new_str = str(new_value)
            current_content = await self.repo_manager.read_file(file_path)

            # Create workflows: missing file + empty old_str => create file.
            if current_content is None:
                if old_str != "":
                    return (
                        False,
                        "ValidationError: old_str must be empty when creating a new file",
                    )
                if new_str == "":
                    return (
                        False,
                        "ValidationError: new_str must be non-empty when creating a new file",
                    )
                success = await self.repo_manager.write_file(file_path, new_str)
                if not success:
                    return False, f"Error: failed to write {file_path}"
                return True, f"Successfully created {file_path}"

            if old_value is None or old_str == "":
                return (
                    False,
                    "ValidationError: old_str must be non-empty when editing an existing file",
                )

            if old_str not in current_content:
                # Fallback: if the model provided an imprecise block match but included
                # a top-level Python symbol signature, replace that symbol body directly.
                old_non_empty_lines = [line for line in old_str.splitlines() if line.strip()]
                signature_line = old_non_empty_lines[0].strip() if old_non_empty_lines else ""
                symbol_match = re.match(
                    r"^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b",
                    signature_line,
                )
                if symbol_match:
                    symbol_kind = symbol_match.group(1)
                    symbol_name = symbol_match.group(2)

                    def _replace_top_level_symbol(
                        content: str,
                        kind: str,
                        name: str,
                        replacement: str,
                    ) -> str | None:
                        lines = content.splitlines(keepends=True)
                        start_line_index: int | None = None
                        pattern = re.compile(rf"^{kind}\s+{re.escape(name)}\b")
                        for idx, line in enumerate(lines):
                            if pattern.match(line):
                                start_line_index = idx
                                break
                        if start_line_index is None:
                            return None

                        end_line_index = start_line_index + 1
                        while end_line_index < len(lines):
                            line = lines[end_line_index]
                            if line.strip() == "":
                                end_line_index += 1
                                continue
                            if line.startswith((" ", "\t")):
                                end_line_index += 1
                                continue
                            break

                        start_char = sum(len(line) for line in lines[:start_line_index])
                        end_char = sum(len(line) for line in lines[:end_line_index])
                        replacement_text = (
                            replacement if replacement.endswith("\n") else replacement + "\n"
                        )
                        return content[:start_char] + replacement_text + content[end_char:]

                    symbol_replaced = _replace_top_level_symbol(
                        current_content,
                        symbol_kind,
                        symbol_name,
                        new_str,
                    )
                    if symbol_replaced is not None:
                        success = await self.repo_manager.write_file(file_path, symbol_replaced)
                        if not success:
                            return False, f"Error: failed to write {file_path}"
                        return (
                            True,
                            f"Successfully edited {file_path} via {symbol_kind} {symbol_name} fallback",
                        )

                return False, "Error: old content not found in file. Must match exactly."

            updated_content = current_content.replace(old_str, new_str, 1)
            success = await self.repo_manager.write_file(file_path, updated_content)
            if not success:
                return False, f"Error: failed to write {file_path}"
            return True, f"Successfully edited {file_path}"

        if name == "LIST_FILES":
            directory = _sanitize_single_line(params.get("directory", "."))
            pattern = params.get("pattern")
            sanitized_pattern = None
            if pattern is not None:
                pattern_line = _sanitize_single_line(pattern)
                if pattern_line:
                    sanitized_pattern = pattern_line

            if sanitized_pattern and (sanitized_pattern == "*.py" or sanitized_pattern == "python"):
                files = await self.repo_manager.get_python_files()
            else:
                files = await self.repo_manager.get_file_tree()

            if directory and directory != ".":
                files = [f for f in files if f.startswith(directory)]

            return True, f"Files ({len(files)} total):\n" + "\n".join(files[:100])

        if name == "SHELL":
            command = str(params.get("command", "")).strip()
            if not command:
                return False, "ValidationError: command is required for SHELL"

            proc = await asyncio.create_subprocess_shell(
                command,
                cwd=str(
                    self.repo_manager.current_repo
                    or self.repo_manager.workspace_dir
                ),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=45,
                )
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                return False, f"SHELL timeout after 45s: {command}"

            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")
            output = (stdout + ("\n" + stderr if stderr else "")).strip()
            if len(output) > 8000:
                output = output[:8000] + "\n...(truncated)"
            if proc.returncode != 0:
                return False, f"SHELL exit={proc.returncode}\n{output}"
            return True, f"SHELL exit=0\n{output}"

        if name == "SUBMIT":
            diff = await self.repo_manager.get_diff()
            has_changes = bool(diff.strip())
            return (
                True,
                f"Submitted. has_changes={has_changes}. "
                f"patch_bytes={len(diff.encode('utf-8', errors='replace'))}",
            )

        return False, f"ValidationError: unknown tool '{name}'"

    def _get_tool_descriptions(self) -> str:
        """Get tool descriptions for the agent prompt."""
        return """Available tools:
- SEARCH_CODE: Search for code patterns. Params: query (str), file_pattern (str, optional)
- READ_FILE: Read a file's contents. Params: file_path (str), start_line (int, optional), end_line (int, optional)
- EDIT_FILE: Edit file text. Params: file_path (str), old_str (str), new_str (str). For existing files, old_str must be exact non-empty text to replace.
- LIST_FILES: List files in a directory. Params: directory (str, default "."), pattern (str, optional)
- SHELL: Run a shell command in the repo workspace. Params: command (str)
- SUBMIT: Submit the current changes as the solution. No params needed."""


# ============================================================================
# Claude Code Provider
# ============================================================================


class ClaudeCodeProvider(BaseSWEBenchProvider):
    """Provider that uses Anthropic's Claude API with tool use for SWE-bench tasks."""

    def __init__(
        self,
        repo_manager: RepositoryManager,
        max_steps: int = 30,
        model: str = "claude-sonnet-4-20250514",
        api_key: str | None = None,
        trace_hook: Callable[[str, str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(repo_manager, max_steps, trace_hook=trace_hook)
        self._model = model
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")

    @property
    def id(self) -> AgentProviderId:
        return "claude-code"

    @property
    def label(self) -> str:
        return "Claude Code"

    async def execute_task(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
    ) -> TaskResult:
        """Execute task using Claude's API with tool use."""
        try:
            from anthropic import AsyncAnthropic
        except ImportError:
            return TaskResult(
                success=False,
                summary="anthropic package not installed",
                error="pip install anthropic",
            )

        if not self._api_key:
            return TaskResult(
                success=False,
                summary="ANTHROPIC_API_KEY not set",
                error="Set ANTHROPIC_API_KEY environment variable",
            )

        client = AsyncAnthropic(api_key=self._api_key)
        await ctx.append_output(f"Starting Claude Code with model {self._model}")
        await self._trace(
            "claude-code",
            "provider_start",
            {
                "model": self._model,
                "max_steps": self.max_steps,
                "task_name": task.name,
            },
        )

        # Define tools for Claude
        tools = [
            {
                "name": "search_code",
                "description": "Search for code patterns in the repository",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "file_pattern": {"type": "string", "description": "Optional file glob pattern"},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "read_file",
                "description": "Read a file's contents",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Path to file"},
                        "start_line": {"type": "integer", "description": "Start line (optional)"},
                        "end_line": {"type": "integer", "description": "End line (optional)"},
                    },
                    "required": ["file_path"],
                },
            },
            {
                "name": "edit_file",
                "description": "Edit a file by replacing old text with new text",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Path to file"},
                        "old_str": {"type": "string", "description": "Text to replace"},
                        "new_str": {"type": "string", "description": "Replacement text"},
                    },
                    "required": ["file_path", "old_str", "new_str"],
                },
            },
            {
                "name": "list_files",
                "description": "List files in a directory",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "directory": {"type": "string", "description": "Directory path", "default": "."},
                        "pattern": {"type": "string", "description": "Optional glob pattern"},
                    },
                },
            },
            {
                "name": "shell",
                "description": "Run a shell command in the repository workspace",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Shell command to run"},
                    },
                    "required": ["command"],
                },
            },
            {
                "name": "submit",
                "description": "Submit the current changes as the solution",
                "input_schema": {
                    "type": "object",
                    "properties": {},
                },
            },
        ]

        messages: list[dict[str, object]] = [
            {
                "role": "user",
                "content": (
                    f"You are a coding agent. Your goal is to FIX a bug in the repository "
                    f"by EDITING the source code, then SUBMIT.\n\n"
                    f"## Task\n{task.description}\n\n"
                    f"## CRITICAL INSTRUCTIONS\n"
                    f"1. Use SEARCH_CODE and READ_FILE to find the buggy code\n"
                    f"2. Use SHELL when needed to inspect or validate behavior\n"
                    f"3. Use EDIT_FILE to fix the source code (the actual .py file, NOT test files)\n"
                    f"4. Use SUBMIT to submit your fix\n\n"
                    f"DO NOT just write test scripts or reproduction scripts. "
                    f"You MUST edit the source code to fix the bug. "
                    f"DO NOT create new files unless absolutely necessary for the fix.\n\n"
                    f"Working directory: {ctx.working_directory}"
                ),
            }
        ]

        files_modified: list[str] = []
        files_created: list[str] = []
        submitted = False
        fatal_error: str | None = None
        tool_error_count = 0
        token_estimate = len(task.description.split())
        steps_executed = 0

        for step in range(self.max_steps):
            steps_executed = step + 1
            if ctx.is_cancelled():
                return TaskResult(
                    success=False,
                    summary="Task cancelled",
                    files_modified=files_modified,
                    files_created=files_created,
                    error="Cancelled",
                    extra={
                        "estimated_tokens": token_estimate,
                        "submitted": submitted,
                        "tool_errors": tool_error_count,
                    },
                )

            while ctx.is_paused():
                await asyncio.sleep(1)

            await ctx.update_progress(int((step / self.max_steps) * 100))
            await self._trace(
                "claude-code",
                "model_request",
                {
                    "step": step + 1,
                    "message_count": len(messages),
                    "messages": messages,
                },
            )

            try:
                response = await client.messages.create(
                    model=self._model,
                    max_tokens=4096,
                    tools=tools,
                    messages=messages,
                )
            except Exception as e:
                await ctx.append_output(f"API error at step {step + 1}: {e}")
                fatal_error = f"Claude API error: {e}"
                await self._trace(
                    "claude-code",
                    "provider_error",
                    {"step": step + 1, "error": fatal_error},
                )
                break

            # Process response
            assistant_content = response.content
            messages.append({"role": "assistant", "content": assistant_content})
            text_blocks = [b for b in assistant_content if getattr(b, "type", "") == "text"]
            assistant_text = " ".join(getattr(b, "text", "") for b in text_blocks)
            token_estimate += len(assistant_text.split())
            await self._trace(
                "claude-code",
                "model_response",
                {
                    "step": step + 1,
                    "stop_reason": str(response.stop_reason),
                    "assistant_text": assistant_text,
                    "raw_blocks": assistant_content,
                },
            )

            # Check for tool use
            tool_use_blocks = [b for b in assistant_content if getattr(b, "type", "") == "tool_use"]

            if not tool_use_blocks:
                # No more tool calls - check if we should submit
                await ctx.append_output(f"Step {step + 1}: {assistant_text[:200]}")
                break

            # Execute tools
            tool_results: list[dict[str, object]] = []
            for block in tool_use_blocks:
                tool_name = getattr(block, "name", "")
                tool_input = getattr(block, "input", {})
                tool_id = getattr(block, "id", "")

                await ctx.append_output(f"Step {step + 1}: {tool_name}({tool_input})")
                await self._trace(
                    "claude-code",
                    "tool_call",
                    {
                        "step": step + 1,
                        "tool_name": tool_name,
                        "tool_input": tool_input,
                    },
                )

                # Map Claude tool names to our tool names
                mapped_name = tool_name.upper()

                try:
                    ok, tool_output = await self._execute_tool(mapped_name, tool_input, ctx)
                except Exception as e:
                    fatal_error = f"Tool execution failed: {mapped_name}: {e}"
                    await self._trace(
                        "claude-code",
                        "tool_exception",
                        {
                            "step": step + 1,
                            "tool_name": mapped_name,
                            "error": fatal_error,
                        },
                    )
                    break

                if not ok:
                    tool_error_count += 1
                await self._trace(
                    "claude-code",
                    "tool_result",
                    {
                        "step": step + 1,
                        "tool_name": mapped_name,
                        "ok": ok,
                        "output": tool_output,
                    },
                )

                # Track file changes
                if mapped_name == "EDIT_FILE" and "file_path" in tool_input:
                    fp = str(tool_input["file_path"])
                    if fp not in files_modified:
                        files_modified.append(fp)

                if mapped_name == "SUBMIT" and ok:
                    submitted = True

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": tool_output[:8000],  # Truncate only what is fed back to model
                })

            if fatal_error is not None:
                break

            messages.append({"role": "user", "content": tool_results})
            token_estimate += sum(
                len(str(result.get("content", "")).split())
                for result in tool_results
            )

            if submitted:
                break

            if response.stop_reason == "end_turn":
                break

        # Get final diff
        diff = await self.repo_manager.get_diff()
        has_patch = bool(diff.strip())
        if not submitted and fatal_error is None and has_patch:
            submitted = True
            await ctx.append_output("Auto-submit: patch detected without explicit SUBMIT")
            await self._trace(
                "claude-code",
                "auto_submit",
                {
                    "reason": "patch_detected_without_submit",
                    "patch_bytes": len(diff.encode("utf-8", errors="replace")),
                },
            )
        success = fatal_error is None and submitted and has_patch
        summary = (
            f"Claude Code completed in {steps_executed} steps. "
            f"submitted={submitted} patch_bytes={len(diff)} tool_errors={tool_error_count}"
        )
        error = fatal_error
        if not submitted and error is None:
            error = "Provider ended without SUBMIT"
        if submitted and not has_patch and error is None:
            error = "SUBMIT called but no patch was generated"

        await self._trace(
            "claude-code",
            "provider_end",
            {
                "steps_executed": steps_executed,
                "submitted": submitted,
                "has_patch": has_patch,
                "tool_errors": tool_error_count,
                "error": error,
            },
        )

        return TaskResult(
            success=success,
            summary=summary,
            files_modified=files_modified,
            files_created=files_created,
            error=error,
            extra={
                "estimated_tokens": token_estimate,
                "submitted": submitted,
                "tool_errors": tool_error_count,
            },
        )


# ============================================================================
# SWE-Agent Provider
# ============================================================================



class SWEBenchTraceHook:
    """Hook to bridge SWE-agent internal events to benchmark tracer."""

    def __init__(
        self,
        *,
        loop: asyncio.AbstractEventLoop,
        trace_fn: Callable[[str, str, dict[str, object]], Awaitable[None]],
    ) -> None:
        self._loop = loop
        self._trace_fn = trace_fn
        self._pending: list[concurrent.futures.Future[None]] = []

    def _submit(self, event: str, data: dict[str, object] | None = None) -> None:
        payload = data or {}
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._trace_fn("swe-agent", event, payload),
                self._loop,
            )
            self._pending.append(future)
        except Exception:
            logger.debug("Failed to submit swe-agent trace event '%s'", event, exc_info=True)

    def on_init(self, agent: Any) -> None:
        _ = agent

    def on_run_start(self) -> None:
        self._submit("run_start", {})

    def on_step_start(self) -> None:
        pass

    def on_step_done(self, step: Any, info: Any) -> None:
        _ = info
        # Extract relevant info from step
        data = {
            "thought": getattr(step, "thought", None),
            "action": getattr(step, "action", None),
            "output": getattr(step, "output", None),
            "submission": getattr(step, "submission", None),
        }
        self._submit("step_done", data)

    def on_run_done(self, trajectory: Any, info: Any) -> None:
        _ = trajectory, info
        self._submit("run_done", {})

    def on_query_message_added(self, **kwargs) -> None:
        _ = kwargs

    async def flush(self) -> None:
        for future in self._pending:
            try:
                await asyncio.wrap_future(future)
            except Exception:
                logger.debug("swe-agent trace hook event failed", exc_info=True)


class SWEAgentProvider(BaseSWEBenchProvider):
    """Provider that uses the canonical sweagent package via Orchestrator adapters."""

    def __init__(
        self,
        runtime: AgentRuntime,
        repo_manager: RepositoryManager,
        max_steps: int = 30,
        model: str | None = None,
        trace_hook: Callable[[str, str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(repo_manager, max_steps, trace_hook=trace_hook)
        self._runtime = runtime
        self._model = model

    @property
    def id(self) -> AgentProviderId:
        return "swe-agent"

    @property
    def label(self) -> str:
        return "SWE-Agent"

    def _parse_swe_agent_response(
        self, text: str
    ) -> tuple[str | None, dict[str, str | int | float | bool | None]]:
        """Parse ACTION/PARAMS response format for compatibility mode."""
        params: dict[str, str | int | float | bool | None] = {}
        allowed_actions = {
            "SEARCH_CODE",
            "READ_FILE",
            "EDIT_FILE",
            "LIST_FILES",
            "SHELL",
            "SUBMIT",
        }

        action: str | None = None
        action_end_idx: int | None = None
        for match in re.finditer(r"ACTION:\s*(\w+)", text, re.IGNORECASE):
            candidate = match.group(1).upper()
            if candidate in allowed_actions:
                action = candidate
                action_end_idx = match.end()
                break
        if action is None:
            first_action = re.search(r"ACTION:\s*(\w+)", text, re.IGNORECASE)
            if first_action:
                action = first_action.group(1).upper()
                action_end_idx = first_action.end()
        if action is None or action_end_idx is None:
            return None, params

        params_block = self._extract_swe_agent_params_block(text, action_end_idx)
        if not params_block:
            return action, params

        stripped_block = params_block.strip()
        if stripped_block.startswith("{"):
            json_start = stripped_block.find("{")
            json_end = stripped_block.rfind("}")
            if json_start != -1 and json_end != -1 and json_end > json_start:
                json_candidate = stripped_block[json_start : json_end + 1]
                try:
                    parsed_json = json.loads(json_candidate)
                except json.JSONDecodeError:
                    parsed_json = None
                if isinstance(parsed_json, dict):
                    for key, value in parsed_json.items():
                        if isinstance(key, str):
                            params[key.strip()] = self._normalize_swe_agent_param_value(value)
                    if params:
                        return action, params

        current_key: str | None = None
        current_value_lines: list[str] = []
        multiline_keys = {"old_str", "new_str", "old_content", "new_content"}

        def flush_param() -> None:
            nonlocal current_key, current_value_lines
            if current_key is None:
                return
            raw_value = "\n".join(current_value_lines).rstrip()
            params[current_key] = self._normalize_swe_agent_param_value(raw_value)
            current_key = None
            current_value_lines = []

        for raw_line in params_block.splitlines():
            if raw_line.strip() == "":
                if current_key is not None:
                    current_value_lines.append("")
                continue

            key_match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", raw_line)
            if key_match:
                flush_param()
                current_key = key_match.group(1).strip()
                value_start = key_match.group(2)
                current_value_lines = [value_start] if value_start else []
                continue

            if current_key is not None and current_key in multiline_keys:
                current_value_lines.append(raw_line)

        flush_param()
        return action, params

    def _extract_swe_agent_params_block(self, text: str, action_end_idx: int) -> str | None:
        """Extract the PARAMS block nearest the selected ACTION."""
        params_match = re.search(r"PARAMS:\s*\n", text[action_end_idx:], re.IGNORECASE)
        if not params_match:
            return None

        block_start = action_end_idx + params_match.end()
        next_section = re.search(
            r"\n\s*(?:---|DISCUSSION:|ACTION:|Step\s+\d+\s*:|<response clipped>|What's your next step\?)\s*",
            text[block_start:],
            re.IGNORECASE,
        )
        block_end = block_start + next_section.start() if next_section else len(text)
        return text[block_start:block_end].rstrip()

    def _normalize_swe_agent_param_value(
        self, raw_value: object
    ) -> str | int | float | bool | None:
        """Normalize parsed parameter values."""
        if isinstance(raw_value, (bool, int, float)) or raw_value is None:
            return raw_value

        value = textwrap.dedent(str(raw_value)).strip()
        if value == "":
            return ""
        if "\n" in value:
            if (
                len(value) >= 6
                and (
                    (value.startswith('"""') and value.endswith('"""'))
                    or (value.startswith("'''") and value.endswith("'''"))
                )
            ):
                return value[3:-3].strip("\n")
            return value

        if (
            len(value) >= 2
            and (
                (value.startswith('"') and value.endswith('"'))
                or (value.startswith("'") and value.endswith("'"))
            )
        ):
            value = value[1:-1]

        lowered = value.lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
        if lowered in ("none", "null"):
            return None

        if re.fullmatch(r"-?\d+", value):
            try:
                return int(value)
            except ValueError:
                pass
        if re.fullmatch(r"-?\d+\.\d+", value):
            try:
                return float(value)
            except ValueError:
                pass
        return value

    async def _execute_legacy_loop(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
        import_error: Exception,
    ) -> TaskResult:
        """Compatibility fallback loop when canonical sweagent is unavailable."""
        await ctx.append_output(
            f"Canonical sweagent unavailable ({import_error}); using compatibility loop."
        )
        await self._trace(
            "swe-agent",
            "compat_fallback_start",
            {"error": str(import_error), "max_steps": self.max_steps},
        )

        submitted = False
        tool_error_count = 0
        files_modified: list[str] = []
        files_created: list[str] = []
        summary = "No valid action produced"
        error: str | None = None
        steps_executed = 0

        for step in range(1, self.max_steps + 1):
            steps_executed = step
            if ctx.is_cancelled():
                return TaskResult(
                    success=False,
                    summary="Task cancelled",
                    files_created=files_created,
                    files_modified=files_modified,
                    error="Cancelled by orchestrator",
                    extra={
                        "submitted": submitted,
                        "tool_errors": tool_error_count,
                        "steps_executed": steps_executed,
                    },
                )

            while ctx.is_paused():
                await asyncio.sleep(0.1)
                if ctx.is_cancelled():
                    return TaskResult(
                        success=False,
                        summary="Task cancelled while paused",
                        files_created=files_created,
                        files_modified=files_modified,
                        error="Cancelled by orchestrator",
                        extra={
                            "submitted": submitted,
                            "tool_errors": tool_error_count,
                            "steps_executed": steps_executed,
                        },
                    )

            prompt = (
                "You are SWE-Agent.\n"
                "Respond with:\n"
                "DISCUSSION: <brief>\n"
                "ACTION: <SEARCH_CODE|READ_FILE|EDIT_FILE|LIST_FILES|SHELL|SUBMIT>\n"
                "PARAMS:\n"
                "<yaml or json params>\n\n"
                f"Task: {task.description}\n"
                f"Step: {step}/{self.max_steps}\n"
            )

            response = await self._runtime.use_model(
                "TEXT_SMALL",
                {"prompt": prompt, "temperature": 0.0},
            )
            action, params = self._parse_swe_agent_response(response or "")
            if action is None:
                tool_error_count += 1
                summary = "No ACTION parsed from response"
                continue

            await self._trace(
                "swe-agent",
                "step_action",
                {"step": step, "action": action, "params": params},
            )
            ok, tool_output = await self._execute_tool(action, params, ctx)
            await ctx.append_output(
                f"Step {step} {action}: {'ok' if ok else 'error'}\n{tool_output}"
            )

            if action == "EDIT_FILE":
                file_path = params.get("file_path")
                if isinstance(file_path, str) and file_path not in files_modified:
                    files_modified.append(file_path)

            if not ok:
                tool_error_count += 1
                summary = f"{action} failed"
                error = tool_output
                continue

            if action == "SUBMIT":
                submitted = True
                summary = "Patch submitted"
                error = None
                diff_text = await self.repo_manager.get_diff()
                has_patch = bool(diff_text.strip())
                await self._trace(
                    "swe-agent",
                    "provider_end",
                    {
                        "submitted": submitted,
                        "steps_executed": steps_executed,
                        "has_patch": has_patch,
                        "tool_errors": tool_error_count,
                    },
                )
                return TaskResult(
                    success=has_patch,
                    summary=summary,
                    files_created=files_created,
                    files_modified=files_modified,
                    error=None if has_patch else "SUBMIT called but no patch was generated",
                    extra={
                        "submitted": submitted,
                        "tool_errors": tool_error_count,
                        "steps_executed": steps_executed,
                    },
                )

        diff_text = await self.repo_manager.get_diff()
        has_patch = bool(diff_text.strip())
        if has_patch:
            submitted = True
            summary = "Max steps reached; auto-submitted existing patch"
            error = None
        else:
            summary = "No patch generated"
            error = error or "No patch generated"

        await self._trace(
            "swe-agent",
            "provider_end",
            {
                "submitted": submitted,
                "steps_executed": steps_executed,
                "has_patch": has_patch,
                "tool_errors": tool_error_count,
                "error": error,
            },
        )
        return TaskResult(
            success=has_patch,
            summary=summary,
            files_created=files_created,
            files_modified=files_modified,
            error=error,
            extra={
                "submitted": submitted,
                "tool_errors": tool_error_count,
                "steps_executed": steps_executed,
            },
        )

    async def execute_task(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
    ) -> TaskResult:
        """Execute task using the canonical sweagent package."""
        
        # Imports here to avoid top-level dependency if package is missing/broken
        try:
            from sweagent.agent.agents import DefaultAgent, DefaultAgentConfig
            from sweagent.agent.models_orchestrator import OrchestratorModel, OrchestratorModelConfig
            from sweagent.environment.orchestrator import OrchestratorDeployment
            from sweagent.environment.swe_env import SWEEnv
            from sweagent.tools.tools import ToolConfig, ToolHandler
            from sweagent.agent.problem_statement import TextProblemStatement
            from sweagent.tools.parsing import ThoughtActionParser
        except ImportError as e:
            return TaskResult(
                success=False,
                summary="sweagent package not found or incomplete",
                error=f"ImportError: {e}",
            )

        await ctx.append_output("Starting canonical SWE-Agent...")
        await self._trace(
            "swe-agent",
            "provider_start",
            {"mode": "canonical", "max_steps": self.max_steps},
        )
        
        # 1. Setup Orchestrator Deployment
        deployment = OrchestratorDeployment(ctx)
        
        # 2. Setup Environment
        # repo=None because orchestrator manages the repo
        env = SWEEnv(
            deployment=deployment,
            repo=None,
            post_startup_commands=[],
            name="orchestrator_env"
        )
        
        # 3. Setup Model
        model_name = self._model or "gpt-4o"
        model_config = OrchestratorModelConfig(name=model_name)
        tool_config = ToolConfig(
            enable_bash_tool=True,
            parse_function=ThoughtActionParser(),
        )
        
        model = OrchestratorModel(
            config=model_config,
            tools=tool_config,
            orchestrator_runtime=self._runtime
        )
        
        # 4. Setup Agent
        agent_config = DefaultAgentConfig(
            name="swe-agent",
            tools=tool_config,
            model=model_config,
        )
        
        tool_handler = ToolHandler(tool_config)
        
        agent = DefaultAgent(
            templates=agent_config.templates,
            tools=tool_handler,
            history_processors=agent_config.history_processors,
            model=model,
            max_requeries=3,
        )
        
        # Hook up tracing
        swe_hook: SWEBenchTraceHook | None = None
        if self._trace_hook:
            swe_hook = SWEBenchTraceHook(
                loop=asyncio.get_running_loop(),
                trace_fn=self._trace_hook,
            )
            agent.add_hook(swe_hook)
            
        # 5. Run Layout
        ps = TextProblemStatement(
            id=task.name,
            text=task.description
        )
        
        import tempfile
        from pathlib import Path
        
        with tempfile.TemporaryDirectory() as tmpdir:
             try:
                 # Run in thread executor to avoid blocking the loop
                 result = await asyncio.to_thread(
                     agent.run,
                     env=env,
                     problem_statement=ps,
                     output_dir=Path(tmpdir)
                 )
             except Exception as e:
                logger.error(f"SWE-Agent run failed: {e}", exc_info=True)
                return TaskResult(
                    success=False,
                    summary=f"SWE-Agent run failed: {e}",
                    error=str(e)
                )

        if swe_hook is not None:
            await swe_hook.flush()
        
        # 6. Extract results
        # DefaultAgent.run returns RunResult which has .info dict
        # We need to know where the diff/submission is.
        # sweagent usually leaves changes in the repo.
        
        diff = await self.repo_manager.get_diff()
        has_patch = bool(diff.strip())
        
        success = has_patch
        summary = f"SWE-Agent finished. Patch generated: {has_patch}."

        await self._trace(
            "swe-agent",
            "provider_end",
            {
                "mode": "canonical",
                "has_patch": has_patch,
                "error": None if has_patch else "No patch generated",
            },
        )
        
        return TaskResult(
            success=success,
            summary=summary,
            files_modified=[],
            files_created=[],
            error=None if success else "No patch generated",
            extra={
                "submitted": has_patch,
                "tool_errors": 0,
            },
        )


# ============================================================================
# Eliza Code Provider
# ============================================================================


class ElizaCodeProvider(BaseSWEBenchProvider):
    """Provider that uses the full ElizaOS message pipeline with code capabilities."""

    def __init__(
        self,
        runtime: AgentRuntime,
        repo_manager: RepositoryManager,
        max_steps: int = 30,
        model: str | None = None,
        trace_hook: Callable[[str, str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(repo_manager, max_steps, trace_hook=trace_hook)
        self._runtime = runtime
        self._model = model

    @staticmethod
    def _is_generic_issue_request_reply(text: str, thought: str) -> bool:
        """Detect boilerplate 'please provide issue details' replies."""
        combined = f"{thought}\n{text}".lower()
        return (
            "github issue" in combined
            and "provide" in combined
            and ("ready to help" in combined or "work on" in combined)
        )

    @property
    def id(self) -> AgentProviderId:
        return "eliza-code"

    @property
    def label(self) -> str:
        return "Eliza Code"

    def _parse_fallback_action_response(
        self, text: str
    ) -> tuple[str | None, dict[str, str | int | float | bool | None]]:
        """Parse fallback ACTION/PARAMS response format."""
        params: dict[str, str | int | float | bool | None] = {}
        allowed_actions = {
            "SEARCH_CODE",
            "READ_FILE",
            "EDIT_FILE",
            "LIST_FILES",
            "SHELL",
            "SUBMIT",
        }

        action: str | None = None
        action_end_idx: int | None = None
        for match in re.finditer(r"ACTION:\s*(\w+)", text, re.IGNORECASE):
            candidate = match.group(1).upper()
            if candidate in allowed_actions:
                action = candidate
                action_end_idx = match.end()
                break
        if action is None:
            first_action = re.search(r"ACTION:\s*(\w+)", text, re.IGNORECASE)
            if first_action:
                action = first_action.group(1).upper()
                action_end_idx = first_action.end()
        if action is None or action_end_idx is None:
            return None, params

        params_block = self._extract_fallback_params_block(text, action_end_idx)
        if not params_block:
            return action, params

        stripped_block = params_block.strip()
        if stripped_block.startswith("{"):
            json_start = stripped_block.find("{")
            json_end = stripped_block.rfind("}")
            if json_start != -1 and json_end != -1 and json_end > json_start:
                json_candidate = stripped_block[json_start : json_end + 1]
                try:
                    parsed_json = json.loads(json_candidate)
                except json.JSONDecodeError:
                    parsed_json = None
                if isinstance(parsed_json, dict):
                    for key, value in parsed_json.items():
                        if isinstance(key, str):
                            params[key.strip()] = self._normalize_fallback_param_value(value)
                    if params:
                        return action, params

        current_key: str | None = None
        current_value_lines: list[str] = []
        multiline_keys = {"old_str", "new_str", "old_content", "new_content"}

        def flush_param() -> None:
            nonlocal current_key, current_value_lines
            if current_key is None:
                return
            raw_value = "\n".join(current_value_lines).rstrip()
            params[current_key] = self._normalize_fallback_param_value(raw_value)
            current_key = None
            current_value_lines = []

        for raw_line in params_block.splitlines():
            if raw_line.strip() == "":
                if current_key is not None:
                    current_value_lines.append("")
                continue

            key_match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", raw_line)
            if key_match:
                flush_param()
                current_key = key_match.group(1).strip()
                value_start = key_match.group(2)
                current_value_lines = [value_start] if value_start else []
                continue

            if current_key is not None:
                if current_key in multiline_keys:
                    current_value_lines.append(raw_line)

        flush_param()

        return action, params

    def _extract_fallback_params_block(self, text: str, action_end_idx: int) -> str | None:
        """Extract the PARAMS block nearest the selected ACTION."""
        params_match = re.search(r"PARAMS:\s*\n", text[action_end_idx:], re.IGNORECASE)
        if not params_match:
            return None

        block_start = action_end_idx + params_match.end()
        next_section = re.search(
            r"\n\s*(?:---|DISCUSSION:|ACTION:|Step\s+\d+\s*:|<response clipped>|What's your next step\?)\s*",
            text[block_start:],
            re.IGNORECASE,
        )
        block_end = block_start + next_section.start() if next_section else len(text)
        return text[block_start:block_end].rstrip()

    def _normalize_fallback_param_value(
        self, raw_value: object
    ) -> str | int | float | bool | None:
        """Normalize fallback parsed parameter values."""
        if isinstance(raw_value, bool):
            return raw_value
        if isinstance(raw_value, int):
            return raw_value
        if isinstance(raw_value, float):
            return raw_value
        if raw_value is None:
            return None

        value = textwrap.dedent(str(raw_value)).strip()
        if value == "":
            return ""
        if "\n" in value:
            if (
                len(value) >= 6
                and (
                    (value.startswith('"""') and value.endswith('"""'))
                    or (value.startswith("'''") and value.endswith("'''"))
                )
            ):
                return value[3:-3].strip("\n")
            return value

        if (
            len(value) >= 2
            and (
                (value.startswith('"') and value.endswith('"'))
                or (value.startswith("'") and value.endswith("'"))
            )
        ):
            value = value[1:-1]

        lowered = value.lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
        if lowered in ("none", "null"):
            return None

        if re.fullmatch(r"-?\d+", value):
            try:
                return int(value)
            except ValueError:
                pass

        if re.fullmatch(r"-?\d+\.\d+", value):
            try:
                return float(value)
            except ValueError:
                pass

        return value

    async def execute_task(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
    ) -> TaskResult:
        """Execute task using the full ElizaOS canonical message handling pipeline."""
        import uuid as uuid_mod

        from elizaos.types.memory import Memory
        from elizaos.types.primitives import Content, as_uuid, string_to_uuid

        await ctx.append_output("Starting Eliza Code agent")
        await self._trace(
            "eliza-code",
            "provider_start",
            {"max_steps": self.max_steps, "task_name": task.name, "model": self._model},
        )

        room_id = string_to_uuid(f"orchestrated-swebench:{task.id}")
        user_id = string_to_uuid("orchestrated-swebench:orchestrator")

        files_modified: list[str] = []
        submitted = False
        fatal_error: str | None = None
        tool_error_count = 0
        token_estimate = len(task.description.split())
        steps_executed = 0
        last_observation = ""
        reply_streak = 0
        fallback_mode = False
        fallback_history: list[str] = []
        fallback_edit_count = 0
        forced_edit_attempted = False
        last_read_file_path: str | None = None

        # Initial message with the task
        initial_message = Memory(
            id=as_uuid(str(uuid_mod.uuid4())),
            entity_id=user_id,
            agent_id=self._runtime.agent_id,
            room_id=room_id,
            created_at=int(time.time() * 1000),
            content=Content(
                text=(
                    f"Fix this issue:\n\n{task.description}\n\n"
                    f"Use the available tools to explore and fix the code, then SUBMIT."
                ),
                source="orchestrated-swebench",
                channel_type="API",
            ),
        )

        for step in range(self.max_steps):
            steps_executed = step + 1
            if ctx.is_cancelled():
                return TaskResult(
                    success=False,
                    summary="Task cancelled",
                    files_modified=files_modified,
                    error="Cancelled",
                    extra={
                        "estimated_tokens": token_estimate,
                        "submitted": submitted,
                        "tool_errors": tool_error_count,
                    },
                )

            while ctx.is_paused():
                await asyncio.sleep(1)

            await ctx.update_progress(int((step / self.max_steps) * 100))

            if fallback_mode:
                from elizaos.types.model import ModelType

                fallback_prompt_parts = [
                    f"Issue to fix:\n{task.description}",
                    f"Working directory: {ctx.working_directory}",
                    f"Current step: {step + 1} of {self.max_steps}.",
                    self._get_tool_descriptions(),
                    "Respond in this exact format:",
                    "DISCUSSION: <short reasoning>",
                    "ACTION: <TOOL_NAME>",
                    "PARAMS:",
                    "  <param_name>: <value>",
                    "When done, use ACTION: SUBMIT",
                ]
                steps_remaining = self.max_steps - (step + 1)
                if steps_remaining <= 8 and fallback_edit_count == 0:
                    fallback_prompt_parts.append(
                        "Deadline mode: stop exploring and perform EDIT_FILE now using the best fix you can infer."
                    )
                if steps_remaining <= 3:
                    fallback_prompt_parts.append(
                        "Finalization mode: only EDIT_FILE or SUBMIT are allowed. "
                        "If no further edits are needed, use SUBMIT now."
                    )
                if fallback_history:
                    fallback_prompt_parts.append("Previous actions and observations:")
                    fallback_prompt_parts.extend(fallback_history[-8:])
                fallback_prompt_parts.append("What's your next step?")
                fallback_prompt = "\n\n".join(fallback_prompt_parts)
                token_estimate += len(fallback_prompt.split())

                await self._trace(
                    "eliza-code",
                    "fallback_model_request",
                    {"step": step + 1, "prompt": fallback_prompt},
                )
                try:
                    fallback_request_params: dict[str, object] = {
                        "prompt": fallback_prompt,
                        "system": (
                            "You are a coding agent fixing a bug. You MUST edit the source "
                            "code (not test files) to fix the bug, then SUBMIT. "
                            "Use only SEARCH_CODE, READ_FILE, EDIT_FILE, LIST_FILES, SHELL, SUBMIT. "
                            "Do not use REPLY. Do not create test scripts."
                        ),
                        "temperature": 0.1,
                        "maxTokens": 4096,
                    }
                    if self._model:
                        fallback_request_params["model_name"] = self._model
                    fallback_response = await self._runtime.use_model(
                        ModelType.TEXT_LARGE,
                        fallback_request_params,
                    )
                except Exception as e:
                    fatal_error = f"Fallback model error: {e}"
                    await self._trace(
                        "eliza-code",
                        "provider_error",
                        {"step": step + 1, "error": fatal_error, "mode": "fallback"},
                    )
                    break

                fallback_text = str(fallback_response) if fallback_response else ""
                token_estimate += len(fallback_text.split())
                await self._trace(
                    "eliza-code",
                    "fallback_model_response",
                    {"step": step + 1, "response_text": fallback_text},
                )

                fallback_action, fallback_params = self._parse_fallback_action_response(
                    fallback_text
                )
                if not fallback_action:
                    fallback_history.append(
                        f"Step {step + 1}: NO_ACTION\nTEXT: {fallback_text[:500]}"
                    )
                    await ctx.append_output(f"Step {step + 1}: No fallback action parsed")
                    continue

                if fallback_action.upper() == "REPLY":
                    fallback_history.append(
                        f"Step {step + 1}: REPLY ignored"
                    )
                    await ctx.append_output(
                        f"Step {step + 1}: REPLY ignored in fallback mode"
                    )
                    continue

                if (
                    steps_remaining <= 3
                    and fallback_edit_count == 0
                    and fallback_action.upper() not in {"EDIT_FILE", "SUBMIT"}
                    and not forced_edit_attempted
                ):
                    forced_edit_attempted = True
                    forced_prompt_parts = [
                        "Final-step recovery mode.",
                        "You MUST output ACTION: EDIT_FILE with valid params for a real code change.",
                        "Allowed keys in PARAMS: file_path, old_str, new_str.",
                        f"Issue:\n{task.description}",
                    ]
                    if last_read_file_path:
                        forced_prompt_parts.append(f"Likely target file: {last_read_file_path}")
                    if last_observation:
                        forced_prompt_parts.append(
                            f"Recent file observation:\n{last_observation[:2500]}"
                        )
                    forced_prompt_parts.append(
                        "If and only if editing is impossible, use ACTION: SUBMIT."
                    )
                    forced_prompt = "\n\n".join(forced_prompt_parts)
                    await self._trace(
                        "eliza-code",
                        "forced_edit_request",
                        {"step": step + 1, "prompt": forced_prompt},
                    )
                    try:
                        forced_request_params: dict[str, object] = {
                            "prompt": forced_prompt,
                            "system": (
                                "Return exactly DISCUSSION/ACTION/PARAMS format. "
                                "Do not use REPLY."
                            ),
                            "temperature": 0.0,
                            "maxTokens": 4096,
                        }
                        if self._model:
                            forced_request_params["model_name"] = self._model
                        forced_response = await self._runtime.use_model(
                            ModelType.TEXT_LARGE,
                            forced_request_params,
                        )
                    except Exception as e:
                        await self._trace(
                            "eliza-code",
                            "forced_edit_error",
                            {"step": step + 1, "error": str(e)},
                        )
                        forced_response = None

                    forced_text = str(forced_response) if forced_response else ""
                    await self._trace(
                        "eliza-code",
                        "forced_edit_response",
                        {"step": step + 1, "response_text": forced_text},
                    )
                    forced_action, forced_params = self._parse_fallback_action_response(
                        forced_text
                    )
                    if forced_action and forced_action.upper() == "EDIT_FILE":
                        await self._trace(
                            "eliza-code",
                            "action_overridden",
                            {
                                "step": step + 1,
                                "from_action": fallback_action,
                                "to_action": "EDIT_FILE",
                                "reason": "forced_edit_recovery",
                            },
                        )
                        fallback_action = forced_action
                        fallback_params = forced_params

                if steps_remaining <= 3 and fallback_action.upper() not in {"EDIT_FILE", "SUBMIT"}:
                    await self._trace(
                        "eliza-code",
                        "action_overridden",
                        {
                            "step": step + 1,
                            "from_action": fallback_action,
                            "to_action": "SUBMIT",
                            "reason": "finalization_mode",
                        },
                    )
                    fallback_action = "SUBMIT"
                    fallback_params = {}

                await ctx.append_output(
                    f"Step {step + 1}: {fallback_action}({fallback_params}) [fallback]"
                )
                await self._trace(
                    "eliza-code",
                    "tool_call",
                    {
                        "step": step + 1,
                        "action": fallback_action,
                        "params": fallback_params,
                        "mode": "fallback",
                    },
                )

                try:
                    ok, observation = await self._execute_tool(
                        fallback_action, fallback_params, ctx
                    )
                except Exception as e:
                    fatal_error = f"Fallback tool execution failed: {fallback_action}: {e}"
                    await self._trace(
                        "eliza-code",
                        "tool_exception",
                        {
                            "step": step + 1,
                            "action": fallback_action,
                            "error": fatal_error,
                            "mode": "fallback",
                        },
                    )
                    break

                last_observation = observation
                if not ok:
                    tool_error_count += 1
                await self._trace(
                    "eliza-code",
                    "tool_result",
                    {
                        "step": step + 1,
                        "action": fallback_action,
                        "ok": ok,
                        "observation": observation,
                        "mode": "fallback",
                    },
                )

                fallback_history.append(
                    f"Step {step + 1}: {fallback_action} "
                    f"ok={ok} params={str(fallback_params)[:200]} obs={observation[:240]}"
                )

                if fallback_action.upper() == "EDIT_FILE" and "file_path" in fallback_params:
                    fallback_edit_count += 1
                    fp = str(fallback_params["file_path"])
                    if fp not in files_modified:
                        files_modified.append(fp)
                if fallback_action.upper() == "READ_FILE" and "file_path" in fallback_params:
                    last_read_file_path = str(fallback_params["file_path"])

                if fallback_action.upper() == "SUBMIT" and ok:
                    submitted = True
                    break
                continue

            # Use canonical message handling
            if step == 0:
                message_to_send = initial_message
            else:
                continue_prompt = (
                    "Continue solving this issue:\n\n"
                    f"{task.description}\n\n"
                    "Use ONLY these actions: SEARCH_CODE, READ_FILE, EDIT_FILE, "
                    "LIST_FILES, SHELL, SUBMIT.\n"
                    "Do not use REPLY.\n\n"
                    f"Previous observation:\n{last_observation[:1500]}"
                )
                message_to_send = Memory(
                    id=as_uuid(str(uuid_mod.uuid4())),
                    entity_id=user_id,
                    agent_id=self._runtime.agent_id,
                    room_id=room_id,
                    created_at=int(time.time() * 1000),
                    content=Content(
                        text=continue_prompt,
                        source="orchestrated-swebench",
                        channel_type="API",
                    ),
                )

            try:
                await self._trace(
                    "eliza-code",
                    "message_request",
                    {
                        "step": step + 1,
                        "message_text": message_to_send.content.text if message_to_send.content else "",
                    },
                )
                result = await self._runtime.message_service.handle_message(
                    self._runtime,
                    message_to_send,
                )
            except Exception as e:
                await ctx.append_output(f"Message handling error at step {step + 1}: {e}")
                fatal_error = f"Message handling error: {e}"
                await self._trace(
                    "eliza-code",
                    "provider_error",
                    {"step": step + 1, "error": fatal_error},
                )
                break

            # Extract response
            response_text = ""
            response_actions = None
            response_thought = ""
            if result and hasattr(result, "response_content") and result.response_content:
                response_text = result.response_content.text or ""
                response_actions = getattr(result.response_content, "actions", None)
                response_thought = getattr(result.response_content, "thought", "") or ""
                token_estimate += len(response_text.split()) + len(response_thought.split())
                await self._trace(
                    "eliza-code",
                    "message_response",
                    {
                        "step": step + 1,
                        "thought": response_thought,
                        "text": response_text,
                        "actions": response_actions if response_actions else [],
                        "params": getattr(result.response_content, "params", {}),
                    },
                )

            # Check for actions
            if response_actions:
                action = response_actions[0] if response_actions else None
                response_params = getattr(result.response_content, "params", None)
                params: dict[str, str | int | float | bool | None] = {}

                if response_params and action:
                    action_params = response_params.get(action.upper(), {})
                    if isinstance(action_params, dict):
                        params = action_params

                if action:
                    action_upper = action.upper()
                    if action_upper == "REPLY":
                        reply_streak += 1
                        generic_issue_request = self._is_generic_issue_request_reply(
                            response_text,
                            response_thought,
                        )
                        if generic_issue_request:
                            # Avoid wasting multiple steps on the same boilerplate clarification reply.
                            reply_streak = max(reply_streak, 3)
                        await ctx.append_output(
                            f"Step {step + 1}: REPLY ignored (streak={reply_streak})"
                        )
                        await self._trace(
                            "eliza-code",
                            "reply_action_ignored",
                            {
                                "step": step + 1,
                                "reply_streak": reply_streak,
                                "generic_issue_request": generic_issue_request,
                            },
                        )
                        if reply_streak >= 3:
                            fallback_mode = True
                            fallback_reason = (
                                "generic_issue_request_reply"
                                if generic_issue_request
                                else "repeated_reply_actions"
                            )
                            await ctx.append_output(
                                "Switching to fallback action loop after repeated REPLY actions."
                            )
                            await self._trace(
                                "eliza-code",
                                "fallback_enabled",
                                {"step": step + 1, "reason": fallback_reason},
                            )
                        continue

                    reply_streak = 0
                    await ctx.append_output(f"Step {step + 1}: {action}({params})")
                    await self._trace(
                        "eliza-code",
                        "tool_call",
                        {"step": step + 1, "action": action, "params": params},
                    )
                    try:
                        ok, observation = await self._execute_tool(action, params, ctx)
                    except Exception as e:
                        fatal_error = f"Tool execution failed: {action}: {e}"
                        await self._trace(
                            "eliza-code",
                            "tool_exception",
                            {"step": step + 1, "action": action, "error": fatal_error},
                        )
                        break

                    if not ok:
                        tool_error_count += 1
                    last_observation = observation
                    await self._trace(
                        "eliza-code",
                        "tool_result",
                        {
                            "step": step + 1,
                            "action": action,
                            "ok": ok,
                            "observation": observation,
                        },
                    )

                    if action.upper() == "EDIT_FILE" and "file_path" in params:
                        fp = str(params["file_path"])
                        if fp not in files_modified:
                            files_modified.append(fp)

                    if action.upper() == "SUBMIT" and ok:
                        submitted = True
                        break
            else:
                # Try XML parsing fallback
                from ..agent import parse_xml_response

                parsed = parse_xml_response(response_text)
                if parsed.action:
                    parsed_action_upper = parsed.action.upper()
                    if parsed_action_upper == "REPLY":
                        reply_streak += 1
                        generic_issue_request = self._is_generic_issue_request_reply(
                            response_text,
                            "",
                        )
                        if generic_issue_request:
                            reply_streak = max(reply_streak, 3)
                        await ctx.append_output(
                            f"Step {step + 1}: REPLY ignored (streak={reply_streak})"
                        )
                        await self._trace(
                            "eliza-code",
                            "reply_action_ignored",
                            {
                                "step": step + 1,
                                "reply_streak": reply_streak,
                                "source": "xml_fallback",
                                "generic_issue_request": generic_issue_request,
                            },
                        )
                        if reply_streak >= 3:
                            fallback_mode = True
                            fallback_reason = (
                                "generic_issue_request_reply_xml"
                                if generic_issue_request
                                else "repeated_reply_actions_xml"
                            )
                            await ctx.append_output(
                                "Switching to fallback action loop after repeated REPLY actions."
                            )
                            await self._trace(
                                "eliza-code",
                                "fallback_enabled",
                                {"step": step + 1, "reason": fallback_reason},
                            )
                        continue

                    reply_streak = 0
                    await ctx.append_output(f"Step {step + 1}: {parsed.action}({parsed.params})")
                    await self._trace(
                        "eliza-code",
                        "tool_call",
                        {
                            "step": step + 1,
                            "action": parsed.action,
                            "params": parsed.params,
                            "source": "xml_fallback",
                        },
                    )
                    try:
                        ok, observation = await self._execute_tool(parsed.action, parsed.params, ctx)
                    except Exception as e:
                        fatal_error = f"Tool execution failed: {parsed.action}: {e}"
                        await self._trace(
                            "eliza-code",
                            "tool_exception",
                            {
                                "step": step + 1,
                                "action": parsed.action,
                                "error": fatal_error,
                                "source": "xml_fallback",
                            },
                        )
                        break

                    if not ok:
                        tool_error_count += 1
                    last_observation = observation
                    await self._trace(
                        "eliza-code",
                        "tool_result",
                        {
                            "step": step + 1,
                            "action": parsed.action,
                            "ok": ok,
                            "observation": observation,
                            "source": "xml_fallback",
                        },
                    )

                    if parsed.action.upper() == "EDIT_FILE" and "file_path" in parsed.params:
                        fp = str(parsed.params["file_path"])
                        if fp not in files_modified:
                            files_modified.append(fp)

                    if parsed.action.upper() == "SUBMIT" and ok:
                        submitted = True
                        break
                else:
                    await ctx.append_output(f"Step {step + 1}: No action (text: {response_text[:100]})")
                    await self._trace(
                        "eliza-code",
                        "no_action",
                        {"step": step + 1, "text": response_text},
                    )

        diff = await self.repo_manager.get_diff()
        has_patch = bool(diff.strip())
        if not submitted and fatal_error is None and has_patch:
            submitted = True
            await ctx.append_output("Auto-submit: max steps reached with non-empty patch")
            await self._trace(
                "eliza-code",
                "auto_submit",
                {
                    "reason": "max_steps_reached_with_patch",
                    "patch_bytes": len(diff.encode("utf-8", errors="replace")),
                },
            )
        success = fatal_error is None and submitted and has_patch
        summary = (
            f"Eliza Code completed in {steps_executed} steps. "
            f"submitted={submitted} patch_bytes={len(diff)} tool_errors={tool_error_count}"
        )
        error = fatal_error
        if not submitted and error is None:
            error = "Provider ended without SUBMIT"
        if submitted and not has_patch and error is None:
            error = "SUBMIT called but no patch was generated"

        await self._trace(
            "eliza-code",
            "provider_end",
            {
                "steps_executed": steps_executed,
                "submitted": submitted,
                "has_patch": has_patch,
                "tool_errors": tool_error_count,
                "error": error,
            },
        )

        return TaskResult(
            success=success,
            summary=summary,
            files_modified=files_modified,
            error=error,
            extra={
                "estimated_tokens": token_estimate,
                "submitted": submitted,
                "tool_errors": tool_error_count,
            },
        )


class CodexProvider(ElizaCodeProvider):
    """Codex provider shim built on the Eliza Code execution loop."""

    @property
    def id(self) -> AgentProviderId:
        return "codex"

    @property
    def label(self) -> str:
        return "Codex"
