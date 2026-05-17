"""Hermes CompactBench compactor using native OpenAI tool calls.

This adapter intentionally does not reuse elizaOS' TypeScript compactor. It
routes the transcript through :class:`hermes_adapter.client.HermesClient` and
requires Hermes to return a native ``tool_calls`` entry for the compaction
artifact. That keeps cross-agent CompactBench claims honest: Hermes is scored
through the same OpenAI-compatible function-calling surface used by Cerebras,
OpenAI, llama.cpp, and vLLM.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping, Sequence

from compactbench.compactors.base import Compactor
from compactbench.contracts import CompactionArtifact, StructuredState, Transcript
from compactbench.providers import Provider

from hermes_adapter.client import HermesClient, MessageResponse


_EMIT_TOOL_NAME = "emit_compaction_artifact"


_EMIT_COMPACTION_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": _EMIT_TOOL_NAME,
        "description": (
            "Emit the complete CompactBench compaction artifact. Preserve exact "
            "identifiers, names, numbers, user decisions, prohibitions, and "
            "late-turn overrides."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "summary_text": {
                    "type": "string",
                    "description": "Concise durable summary of the transcript.",
                },
                "immutable_facts": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "locked_decisions": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "deferred_items": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "forbidden_behaviors": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "entity_map": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                },
                "unresolved_items": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "selected_source_turn_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                },
                "warnings": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": [
                "summary_text",
                "immutable_facts",
                "locked_decisions",
                "deferred_items",
                "forbidden_behaviors",
                "entity_map",
                "unresolved_items",
                "selected_source_turn_ids",
                "warnings",
            ],
        },
    },
}


def _as_list_of_strings(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    return [str(item) for item in value if item is not None]


def _as_entity_map(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): str(item)
        for key, item in value.items()
        if key is not None and item is not None
    }


def _as_turn_ids(value: object, fallback: list[int]) -> list[int]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return fallback
    out: list[int] = []
    for item in value:
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            out.append(item)
        elif isinstance(item, str) and item.strip().isdigit():
            out.append(int(item))
    return out or fallback


def _artifact_to_prior_text(artifact: CompactionArtifact | None) -> str:
    if artifact is None:
        return ""
    state = artifact.structured_state
    sections: list[str] = []
    if artifact.summary_text:
        sections.append(f"summary:\n{artifact.summary_text}")
    for label, items in (
        ("immutable_facts", state.immutable_facts),
        ("locked_decisions", state.locked_decisions),
        ("deferred_items", state.deferred_items),
        ("forbidden_behaviors", state.forbidden_behaviors),
        ("unresolved_items", state.unresolved_items),
    ):
        if items:
            sections.append(f"{label}:\n" + "\n".join(f"- {item}" for item in items))
    if state.entity_map:
        sections.append(
            "entity_map:\n"
            + "\n".join(f"- {key}: {value}" for key, value in state.entity_map.items())
        )
    return "\n\n".join(sections)


def _transcript_turns(transcript: Transcript) -> list[dict[str, object]]:
    return [
        {
            "id": turn.id,
            "role": turn.role.value,
            "content": turn.content,
            "tags": list(turn.tags),
        }
        for turn in transcript.turns
    ]


def _messages_for_compaction(
    transcript: Transcript,
    previous_artifact: CompactionArtifact | None,
) -> list[dict[str, object]]:
    system = (
        "You compact conversations for CompactBench. Use the native "
        f"`{_EMIT_TOOL_NAME}` tool exactly once. Keep exact strings for "
        "identifiers, account numbers, names, codes, quoted constraints, and "
        "late-turn overrides. Do not omit facts solely because they look like "
        "test credentials; this is a synthetic benchmark transcript."
    )
    payload: dict[str, object] = {"turns": _transcript_turns(transcript)}
    prior = _artifact_to_prior_text(previous_artifact)
    if prior:
        payload["previous_artifact"] = prior
    return [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": (
                "Compact this transcript into the required artifact.\n"
                + json.dumps(payload, ensure_ascii=False, indent=2)
            ),
        },
    ]


def _parse_tool_arguments(response: MessageResponse) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    raw_calls = response.params.get("tool_calls") if isinstance(response.params, Mapping) else None
    if not isinstance(raw_calls, Sequence) or isinstance(raw_calls, (str, bytes)):
        raise RuntimeError("Hermes compactor did not return native tool_calls")

    matching: list[Mapping[str, object]] = []
    for call in raw_calls:
        if not isinstance(call, Mapping):
            continue
        name = call.get("name")
        function = call.get("function")
        if not name and isinstance(function, Mapping):
            name = function.get("name")
        if name == _EMIT_TOOL_NAME:
            matching.append(call)
    if not matching:
        names = [
            str(call.get("name") or "")
            for call in raw_calls
            if isinstance(call, Mapping)
        ]
        raise RuntimeError(
            "Hermes compactor returned tool_calls but not "
            f"{_EMIT_TOOL_NAME!r}: {names}"
        )
    if len(matching) > 1:
        warnings.append("multiple_emit_compaction_artifact_calls")

    call = matching[0]
    arguments = call.get("arguments")
    function = call.get("function")
    if arguments is None and isinstance(function, Mapping):
        arguments = function.get("arguments")
    if isinstance(arguments, Mapping):
        return dict(arguments), warnings
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Hermes compactor emitted invalid JSON arguments: {exc}"
            ) from exc
        if isinstance(parsed, Mapping):
            return dict(parsed), warnings
    raise RuntimeError("Hermes compactor emitted non-object tool arguments")


def _artifact_from_arguments(
    args: Mapping[str, object],
    *,
    transcript: Transcript,
    response: MessageResponse,
    model: str,
    provider: str,
    warnings: list[str],
) -> CompactionArtifact:
    source_ids = [turn.id for turn in transcript.turns]
    emitted_warnings = _as_list_of_strings(args.get("warnings"))
    state = StructuredState(
        immutable_facts=_as_list_of_strings(args.get("immutable_facts")),
        locked_decisions=_as_list_of_strings(args.get("locked_decisions")),
        deferred_items=_as_list_of_strings(args.get("deferred_items")),
        forbidden_behaviors=_as_list_of_strings(args.get("forbidden_behaviors")),
        entity_map=_as_entity_map(args.get("entity_map")),
        unresolved_items=_as_list_of_strings(args.get("unresolved_items")),
    )
    raw_calls = response.params.get("tool_calls") if isinstance(response.params, Mapping) else []
    usage = response.params.get("usage") if isinstance(response.params, Mapping) else {}
    return CompactionArtifact(
        schemaVersion="1.0.0",
        summaryText=str(args.get("summary_text") or args.get("summaryText") or ""),
        structured_state=state,
        selectedSourceTurnIds=_as_turn_ids(
            args.get("selected_source_turn_ids") or args.get("selectedSourceTurnIds"),
            source_ids,
        ),
        warnings=[*warnings, *emitted_warnings],
        methodMetadata={
            "agent_family": "hermes",
            "adapter": "hermes-adapter",
            "method": HermesNativeToolCompactor.name,
            "native_tool_calls": True,
            "tool_call_count": len(raw_calls) if isinstance(raw_calls, Sequence) else 0,
            "provider": provider,
            "model": model,
            "usage": dict(usage) if isinstance(usage, Mapping) else {},
            "response_text_chars": len(response.text or ""),
        },
    )


class HermesNativeToolCompactor(Compactor):
    """CompactBench compactor backed by Hermes native function calling."""

    name = "hermes-native-tool-compactor"
    version = "0.1.0"

    def __init__(
        self,
        provider: Provider,
        model: str,
        *,
        client: HermesClient | None = None,
    ) -> None:
        super().__init__(provider, model)
        self._client = client or HermesClient(
            provider=os.environ.get("HERMES_BENCH_PROVIDER", "cerebras"),
            model=model,
            reasoning_effort=os.environ.get("HERMES_COMPACT_REASONING_EFFORT", "low"),
            max_tokens=int(os.environ.get("HERMES_COMPACT_MAX_TOKENS", "4096")),
        )

    async def compact(
        self,
        transcript: Transcript,
        config: dict[str, Any] | None = None,
        previous_artifact: CompactionArtifact | None = None,
    ) -> CompactionArtifact:
        if not isinstance(transcript, Transcript):
            raise TypeError(
                f"Expected compactbench.contracts.Transcript, got {type(transcript).__name__}"
            )
        context: dict[str, object] = {
            "benchmark": "compactbench",
            "task_id": "compactbench-hermes",
            "messages": _messages_for_compaction(transcript, previous_artifact),
            "tools": [_EMIT_COMPACTION_TOOL],
            "tool_choice": "required",
            "temperature": 0.0,
            "reasoning_effort": "low",
            "max_tokens": 4096,
        }
        if config:
            for key in ("temperature", "reasoning_effort", "max_tokens"):
                if key in config:
                    context[key] = config[key]

        response = self._client.send_message(
            "Compact the transcript using the emit_compaction_artifact tool.",
            context=context,
        )
        args, warnings = _parse_tool_arguments(response)
        return _artifact_from_arguments(
            args,
            transcript=transcript,
            response=response,
            model=self.model,
            provider=getattr(self._client, "provider", "unknown"),
            warnings=warnings,
        )


__all__ = ["HermesNativeToolCompactor"]
