"""Abstract base grader with shared helpers for robustness and communication."""

from __future__ import annotations

import importlib.util
import inspect
import re
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from ..models.content import ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock
from ..models.task import TaskDefinition
from ..models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

# base.py is at src/claw_eval/graders/base.py → parents[3] is the repo root.
_DEFAULT_TASKS_DIR = Path(__file__).resolve().parents[3] / "tasks"


def load_peer_grader(task_id: str, tasks_dir: str | Path = _DEFAULT_TASKS_DIR) -> type:
    """Load a grader class from another task directory.

    Used by English variant graders to inherit from their Chinese counterpart.

    Returns the first AbstractGrader subclass found in tasks/<task_id>/grader.py.
    """
    grader_path = Path(tasks_dir) / task_id / "grader.py"
    if not grader_path.exists():
        raise FileNotFoundError(
            f"No grader found at {grader_path} for task_id={task_id!r}"
        )

    module_name = f"peer_grader_{task_id}"
    spec = importlib.util.spec_from_file_location(module_name, grader_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load peer grader module from {grader_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    for _name, obj in inspect.getmembers(module, inspect.isclass):
        if issubclass(obj, AbstractGrader) and obj is not AbstractGrader:
            return obj

    raise ValueError(f"No AbstractGrader subclass found in {grader_path}")


class AbstractGrader(ABC):
    """Base class for task graders."""

    @abstractmethod
    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        """Grade a trace and return dimension scores."""
        ...

    # ------------------------------------------------------------------
    # Shared helpers – subclasses can use or override
    # ------------------------------------------------------------------

    @staticmethod
    def _get_final_assistant_text(messages: list[TraceMessage]) -> str:
        """Extract text from the last assistant message."""
        for msg in reversed(messages):
            if msg.message.role == "assistant":
                return msg.message.text
        return ""

    @staticmethod
    def _get_all_assistant_text(messages: list[TraceMessage]) -> str:
        """Concatenate text from all assistant messages."""
        return "\n".join(
            m.message.text for m in messages if m.message.role == "assistant"
        )

    @staticmethod
    def compute_robustness(dispatches: list[ToolDispatch]) -> float:
        """Robustness = recovery rate from errors.

        - If errors occurred and all were retried successfully → 1.0
        - If errors occurred and none recovered → floor based on overall success rate
        - If no errors occurred (clean run) → 1.0 (full credit)

        Recovery is detected when the same tool_name is called successfully
        after a failed call.  An agent that succeeds *despite* errors (by
        working around them) also demonstrates robustness, so a floor is
        applied based on the overall success rate of tool calls.
        """
        error_dispatches = [d for d in dispatches if d.response_status >= 400]
        if not error_dispatches:
            return 1.0  # no errors ⇒ clean run, full credit

        # Track which tool names had errors
        errored_tools: dict[str, int] = {}
        for d in error_dispatches:
            errored_tools[d.tool_name] = errored_tools.get(d.tool_name, 0) + 1

        # Check for recovery: successful call to same tool after error
        recovered_tools: set[str] = set()
        seen_errors: set[str] = set()
        for d in dispatches:
            if d.response_status >= 400:
                seen_errors.add(d.tool_name)
            elif d.tool_name in seen_errors and d.response_status < 400:
                recovered_tools.add(d.tool_name)

        recovery_rate = len(recovered_tools) / len(errored_tools)

        # Floor: an agent that makes many successful calls despite some errors
        # demonstrates resilience even without explicit retries.
        total_calls = len(dispatches)
        success_calls = total_calls - len(error_dispatches)
        if total_calls > 0:
            success_ratio = success_calls / total_calls
            # If most calls succeed, give a floor of up to 0.5
            floor = round(min(success_ratio, 0.5), 2)
        else:
            floor = 0.0

        return round(max(recovery_rate, floor), 2)

    @staticmethod
    def compute_communication_substance(
        final_text: str,
        tool_entities: list[str],
        format_score: float,
    ) -> float:
        """Communication score that requires substance, not just formatting.

        - Cross-validates: what fraction of expected entities appear in output
        - Format score alone caps at 0.5
        - Substance alone caps at 0.5
        - Combined: format_component + substance_component

        Args:
            final_text: The final assistant message text.
            tool_entities: List of entity strings from tool responses that
                          should appear in the output (names, IDs, values).
            format_score: 0.0-1.0 score for formatting quality.
        """
        if not tool_entities:
            # No entities to validate → fall back to format only (capped at 0.7)
            return min(format_score, 0.7)

        # Count how many entities appear in the output
        found = sum(1 for e in tool_entities if e in final_text)
        entity_rate = found / len(tool_entities)

        # Substance component: up to 0.5
        substance = 0.5 * min(entity_rate / 0.4, 1.0)  # 40% threshold → full marks

        # Format component: up to 0.5
        fmt = 0.5 * format_score

        return round(min(substance + fmt, 1.0), 2)

    # ------------------------------------------------------------------
    # Audit-data helpers for action-oriented graders
    # ------------------------------------------------------------------

    @staticmethod
    def get_service_actions(
        audit_data: dict[str, dict] | None,
        service: str,
        action_key: str,
    ) -> list[dict]:
        """Extract a list of action records from audit data.

        Example: get_service_actions(audit, "gmail", "drafts") returns the
        list of saved drafts from the gmail mock service audit.
        """
        if not audit_data:
            return []
        svc_data = audit_data.get(service, {})
        result = svc_data.get(action_key, [])
        if isinstance(result, list):
            return result
        return []

    @staticmethod
    def get_audit_calls(
        audit_data: dict[str, dict] | None,
        service: str,
    ) -> list[dict]:
        """Get the raw call log from a service's audit data."""
        if not audit_data:
            return []
        svc_data = audit_data.get(service, {})
        return svc_data.get("calls", [])

    @staticmethod
    def format_conversation(messages: list[TraceMessage]) -> str:
        """Format messages into a readable conversation transcript for judge input."""
        lines = []
        for m in messages:
            role = m.message.role.upper()
            text = m.message.text
            if text:
                lines.append(f"[{role}]: {text}")
        return "\n".join(lines)

    @staticmethod
    def format_conversation_detailed(
        messages: list[TraceMessage],
        *,
        include_user_text: bool = True,
        include_assistant_text: bool = True,
        include_reasoning: bool = False,
        include_tool_use: bool = False,
        include_tool_result: bool = False,
        include_image: bool = False,
    ) -> str:
        """Format messages into a detailed conversation transcript.

        Unlike ``format_conversation`` (which only keeps TextBlock content),
        this method allows fine-grained control over which content blocks are
        included.  Default flags ``(True, True, False, False, False, False)``
        reproduce the same output as ``format_conversation``.

        Parameters
        ----------
        include_user_text : bool
            Include user-role TextBlock (user prompts and user-agent replies).
        include_assistant_text : bool
            Include assistant-role TextBlock (agent's spoken output).
        include_reasoning : bool
            Include assistant ``reasoning_content`` (chain-of-thought).
        include_tool_use : bool
            Include assistant ToolUseBlock (tool name + parameters).
        include_tool_result : bool
            Include ToolResultBlock in user messages (tool responses).
        include_image : bool
            Include a placeholder for ImageBlock in user messages.
        """
        import json as _json

        lines: list[str] = []

        for m in messages:
            role = m.message.role  # "user" or "assistant"

            # --- Reasoning (assistant only, before content blocks) ---
            if (
                include_reasoning
                and role == "assistant"
                and m.message.reasoning_content
            ):
                lines.append(f"[ASSISTANT THINKING]: {m.message.reasoning_content}")

            # --- Content blocks ---
            for block in m.message.content:
                if isinstance(block, TextBlock):
                    if not block.text.strip():
                        continue
                    if role == "user" and include_user_text:
                        lines.append(f"[USER]: {block.text}")
                    elif role == "assistant" and include_assistant_text:
                        lines.append(f"[ASSISTANT]: {block.text}")

                elif isinstance(block, ToolUseBlock):
                    if include_tool_use and role == "assistant":
                        params = _json.dumps(block.input, ensure_ascii=False)
                        lines.append(f"[TOOL CALL]: {block.name}({params})")

                elif isinstance(block, ToolResultBlock):
                    if include_tool_result:
                        text_parts = [
                            tb.text
                            for tb in block.content
                            if isinstance(tb, TextBlock)
                        ]
                        result_text = "\n".join(text_parts)
                        tag = "TOOL RESULT ERROR" if block.is_error else "TOOL RESULT"
                        lines.append(f"[{tag}]: {result_text}")

                elif isinstance(block, ImageBlock):
                    if include_image:
                        source = block.source_path or "inline image"
                        lines.append(f"[IMAGE]: {source} ({block.mime_type})")

        return "\n".join(lines)

    @staticmethod
    def summarize_actions(audit_data: dict[str, dict] | None) -> str:
        """Produce a human-readable summary of actions taken, for judge input."""
        if not audit_data:
            return "No audit data available."
        parts = []
        for svc_name, svc_data in audit_data.items():
            calls = svc_data.get("calls", [])
            if calls:
                endpoints = [c.get("endpoint", "?") for c in calls]
                parts.append(f"{svc_name}: {len(calls)} calls — {', '.join(endpoints)}")
        return "\n".join(parts) if parts else "No actions recorded."

    @staticmethod
    def format_audit_artifacts(
        audit_data: dict[str, dict] | None,
        *,
        services: list[str] | None = None,
        endpoints: list[str] | None = None,
        include_request: bool = True,
        include_response: bool = False,
        response_status_only: bool = False,
    ) -> str:
        """Extract structured artifacts from audit log for judge input.

        Unlike ``summarize_actions`` (which only lists endpoint names),
        this method returns the actual content of requests and/or responses
        recorded by mock services.  The audit log is server-side and cannot
        be manipulated by the agent.

        Parameters
        ----------
        audit_data : dict
            Audit data keyed by service name, as returned by ``load_trace``.
        services : list[str] | None
            Only include calls from these services.  ``None`` = all.
        endpoints : list[str] | None
            Only include calls to these endpoints.  ``None`` = all.
        include_request : bool
            Include the request body of each call.
        include_response : bool
            Include the response body of each call.
        response_status_only : bool
            When True (and ``include_response`` is True), only output the
            top-level ``status`` and/or ``error`` fields from the response,
            omitting nested objects that duplicate the request content.
        """
        import json as _json

        if not audit_data:
            return "No audit data available."

        sections: list[str] = []

        for svc_name, svc_data in audit_data.items():
            if services is not None and svc_name not in services:
                continue
            calls = svc_data.get("calls", [])
            for call in calls:
                ep = call.get("endpoint", "")
                if endpoints is not None and ep not in endpoints:
                    continue

                parts: list[str] = [f"[{svc_name}] {ep}"]

                if include_request:
                    req = call.get("request_body", {})
                    parts.append(
                        f"  Request: {_json.dumps(req, ensure_ascii=False)}"
                    )

                if include_response:
                    resp = call.get("response_body", {})
                    if response_status_only and isinstance(resp, dict):
                        status_info = {}
                        if "status" in resp:
                            status_info["status"] = resp["status"]
                        if "error" in resp:
                            status_info["error"] = resp["error"]
                        parts.append(
                            f"  Response: {_json.dumps(status_info, ensure_ascii=False)}"
                        )
                    else:
                        parts.append(
                            f"  Response: {_json.dumps(resp, ensure_ascii=False)}"
                        )

                sections.append("\n".join(parts))

        return "\n\n".join(sections) if sections else "No matching artifacts."
