"""Legacy corpus adapters: distill."""

from __future__ import annotations
from typing import Any, Iterator
from ..eliza_record import (
    ElizaRecord,
    build,
    stable_id,
)
from ..expected_response import ExpectedResponseEncoder
from .common import _norm_role, _strip_surrogates

CLAUDE_DISTILL_SYSTEM = (
    "You are a helpful, careful assistant. Think step by step inside "
    "<think>...</think> tags before producing your final answer."
)


def claude_distill(
    records: Iterator[dict],
    *,
    slug: str,
    license: str,
    split: str,
    encoder: ExpectedResponseEncoder,
) -> Iterator[ElizaRecord]:
    """Adapter for Kassadin88/Claude-Distills (and similarly-shaped distill
    corpora). Each record is `{messages: [system?, user, assistant], source}`
    and the assistant content already contains
    `<think>{reasoning}</think>{final answer}`.

    We preserve the assistant content **verbatim** in `expectedResponse`
    without re-encoding so the student model learns the exact `<think>`
    surface that the active reasoning generation pipeline expects.

    The `messages` array is rendered into `memoryEntries` + `currentMessage`
    + `expectedResponse` so `tokenizer.apply_chat_template(...)` produces
    a chat that is byte-uniform with the upstream distill.
    """

    for r in records:
        msgs = r.get("messages") or []
        if not isinstance(msgs, list) or not msgs:
            continue

        system_parts: list[str] = []
        convo: list[dict[str, Any]] = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            role = _norm_role(m.get("role") or "")
            content = m.get("content") or ""
            if isinstance(content, list):
                content = "".join(
                    p.get("text", "") if isinstance(p, dict) else str(p)
                    for p in content
                )
            content = _strip_surrogates(str(content))
            if role == "system":
                if content.strip():
                    system_parts.append(content)
                continue
            if role not in ("user", "assistant"):
                continue
            convo.append({"role": role, "content": content})

        # Need at least one user turn and one assistant turn — the supervised
        # target is the final assistant turn.
        final_assistant = None
        for i in range(len(convo) - 1, -1, -1):
            if convo[i]["role"] == "assistant":
                final_assistant = convo[i]
                final_idx = i
                break
        if final_assistant is None or not (final_assistant["content"] or "").strip():
            continue
        prior = convo[:final_idx]

        current = None
        for m in reversed(prior):
            if m["role"] == "user" and (m["content"] or "").strip():
                current = {
                    "role": "user",
                    "speaker": "user",
                    "content": m["content"],
                    "channel": "dm",
                }
                prior.remove(m)
                break
        if current is None:
            continue

        memory = [
            {
                "role": m["role"],
                "speaker": m["role"],
                "content": m["content"],
                "channel": "dm",
            }
            for m in prior
        ]

        sys_prompt = "\n\n".join(system_parts).strip() or CLAUDE_DISTILL_SYSTEM
        source = str(r.get("source") or "")

        md = {
            "system_prompt": sys_prompt,
            "claude_source": source,
            "preserve_think_tags": True,
        }

        seed = current["content"] + "|" + final_assistant["content"]
        yield build(
            roomName=stable_id(slug, source, seed),
            agentId="assistant",
            memoryEntries=memory,
            currentMessage=current,
            # Verbatim. The `<think>...</think>final`
            # surface ships through `tokenizer.apply_chat_template` exactly
            # as the distill source recorded it.
            expectedResponse=final_assistant["content"],
            # Intentionally empty — Claude distills are general-purpose Q&A,
            # not elizaOS action routing. Empty list prevents the
            # "Available actions: ..." suffix from being appended to the
            # system prompt by format_for_training.py.
            availableActions=[],
            task_type="claude_distill",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )
