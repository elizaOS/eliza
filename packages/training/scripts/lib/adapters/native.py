"""Legacy corpus adapters: native."""

from __future__ import annotations
from typing import Any
from ..eliza_record import (
    build,
    stable_id,
)


def _eliza_native_extract_messages(
    messages: list[Any],
) -> tuple[
    str,
    list[dict[str, Any]],
    dict[str, Any] | None,
]:
    """Return (system_prompt, memory_entries, current_message) for ElizaRecord.

    Splits the trajectory message list the same way `_split_history` does:
    leading system turns become the system prompt, the last user turn is the
    current message, the remainder is the memory window. Tool turns ride
    along in memory.
    """
    sys_parts: list[str] = []
    memory: list[dict[str, Any]] = []
    last_user: dict[str, Any] | None = None
    for raw in messages:
        if not isinstance(raw, dict):
            continue
        role = raw.get("role")
        content = raw.get("content")
        if role == "system":
            if isinstance(content, str):
                sys_parts.append(content)
            continue
        if role == "user":
            if last_user is not None:
                memory.append(last_user)
            last_user = {"role": "user", "content": content}
            continue
        if role in {"assistant", "tool"}:
            if last_user is not None:
                memory.append(last_user)
                last_user = None
            memory.append({"role": role, "content": content})
    return ("\n".join(sys_parts).strip(), memory, last_user)


def eliza_native_passthrough(records, *, slug, license, split, encoder):
    """Passthrough adapter for already-`eliza_native_v1` JSONL rows.

    Used by the nightly trajectory-export bridge: the TS pipeline writes
    sanitized `eliza_native_v1` rows to disk, this adapter reads them and
    re-emits them as `ElizaRecord` so the existing pack/format pipeline
    picks them up unchanged. No additional privacy filtering — the TS
    export already applied the runtime privacy filter on its write path.

    Rows that fail `validate_native_record` are dropped with an
    `errors.jsonl` entry, same as every other adapter.
    """
    from ..native_record import FORMAT as NATIVE_FORMAT, validate_native_record

    for raw in records:
        if not isinstance(raw, dict):
            continue
        ok, why = validate_native_record(raw)
        if not ok:
            # Mark invalid by emitting an ElizaRecord that will fail
            # is_valid(); the caller writes it to errors.jsonl.
            yield build(
                roomName=stable_id(slug, "invalid", raw.get("trajectoryId", "")),
                agentId="unknown",
                expectedResponse="",
                task_type=f"invalid:{why}",
                source_dataset=slug,
                license=license,
                split=split,
            )
            continue

        request = raw.get("request") or {}
        response = raw.get("response") or {}
        metadata_in = raw.get("metadata") or {}

        sys_prompt, memory, current = _eliza_native_extract_messages(
            request.get("messages") or []
        )
        if current is None:
            prompt_text = request.get("prompt")
            if isinstance(prompt_text, str) and prompt_text.strip():
                current = {"role": "user", "content": prompt_text}
        if current is None:
            continue

        expected = response.get("text")
        if not isinstance(expected, str) or not expected.strip():
            continue

        task_type = (
            metadata_in.get("task_type") or metadata_in.get("task") or "agent_trace"
        )
        agent_id = str(metadata_in.get("agent_id") or raw.get("agentId") or "unknown")
        trajectory_id = str(
            metadata_in.get("trajectory_id") or raw.get("trajectoryId") or ""
        )

        extra_md: dict[str, Any] = {
            "eliza_native_format": NATIVE_FORMAT,
            "boundary": raw.get("boundary", ""),
        }
        if sys_prompt:
            extra_md["system_prompt"] = sys_prompt
        if trajectory_id:
            extra_md["trajectory_id"] = trajectory_id
        call_id = metadata_in.get("call_id") or raw.get("callId")
        if call_id:
            extra_md["call_id"] = str(call_id)

        yield build(
            roomName=stable_id(slug, trajectory_id or "row", str(call_id or "")),
            agentId=agent_id,
            memoryEntries=memory,
            currentMessage=current,
            expectedResponse=expected,
            availableActions=[],
            task_type=str(task_type),
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=extra_md,
        )
