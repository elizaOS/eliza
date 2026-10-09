"""Legacy corpus adapters: calibration."""

from __future__ import annotations
from typing import Any
from ..eliza_record import (
    build,
    stable_id,
)
from .common import _norm_role, _strip_surrogates

_ABLITERATION_PROMPT_KEYS = (
    "prompt",
    "goal",
    "instruction",
    "text",
    "behavior",
    "input",
    "question",
)

_ABLITERATION_SENTINEL = "<abliteration-calibration>"


def _abliteration_prompt(rec: dict[str, Any]) -> str:
    for key in _ABLITERATION_PROMPT_KEYS:
        val = rec.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    msgs = rec.get("messages") or rec.get("conversations")
    if isinstance(msgs, list):
        for m in msgs:
            if not isinstance(m, dict):
                continue
            if _norm_role(str(m.get("role") or m.get("from") or "")) == "user":
                content = m.get("content") or m.get("value") or ""
                if isinstance(content, str) and content.strip():
                    return content.strip()
    return ""


def _abliteration_yield(
    records,
    *,
    slug,
    license,
    split,
    task_type,
    channel,
):
    for r in records:
        if not isinstance(r, dict):
            continue
        prompt = _abliteration_prompt(r)
        if not prompt:
            continue
        prompt = _strip_surrogates(prompt)
        yield build(
            roomName=stable_id(slug, task_type, prompt),
            agentId="calibration",
            currentMessage={
                "role": "user",
                "speaker": "user",
                "content": prompt,
                "channel": channel,
            },
            expectedResponse=_ABLITERATION_SENTINEL,
            availableActions=[],
            task_type=task_type,
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={"abliteration_calibration": True},
        )


def harmful_behaviors(records, *, slug, license, split, encoder):
    """mlabonne/harmful_behaviors — refusal-eliciting prompts. Calibration
    only: emits ElizaRecord with task_type=abliteration_harmful and a
    sentinel expectedResponse. Routed to data/abliteration/harmful.jsonl
    by pack_dataset.py (weight=0.0 in datasets.yaml)."""
    yield from _abliteration_yield(
        records,
        slug=slug,
        license=license,
        split=split,
        task_type="abliteration_harmful",
        channel="abliteration",
    )


def harmless_alpaca(records, *, slug, license, split, encoder):
    """mlabonne/harmless_alpaca — paired benign instructions for
    orthogonal-projection abliteration. Calibration only: emits
    ElizaRecord with task_type=abliteration_harmless and a sentinel
    expectedResponse. Routed to data/abliteration/harmless.jsonl by
    pack_dataset.py (weight=0.0 in datasets.yaml)."""
    yield from _abliteration_yield(
        records,
        slug=slug,
        license=license,
        split=split,
        task_type="abliteration_harmless",
        channel="abliteration",
    )
