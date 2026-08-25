"""Rewriter for regularizer-reasoning-tool.

Original shape (mis-classified as `agent_trace`):
    expectedResponse native JSON:
        thought: <multi-paragraph 3rd-person CoT, sometimes with citations>
        tool_calls[0] REPLY
        providers: [] (often empty)
        text: "<answer>...</answer>"  (the actual final answer in <answer> tags)
        simple: false

The CoT thoughts are written in 3rd person ("We need to compute…") and the
real answer is wrapped in `<answer>...</answer>` (or `<FinalAnswer>` /
`Exact Answer:` patterns inside the thought).

Target shape (`reasoning_cot`):
    thought: <complete original CoT with wrapper tags removed>
    text: <extracted final answer with wrapper tags stripped>

Records where no terminal answer can be extracted are dropped.
"""

from __future__ import annotations

import re
from typing import Any

_ANSWER_TAG_RE = re.compile(r"<answer>(.*?)</answer>", re.DOTALL | re.IGNORECASE)
_FINAL_ANSWER_TAG_RE = re.compile(r"<FinalAnswer>(.*?)</FinalAnswer>", re.DOTALL | re.IGNORECASE)
_ANSWER_GENERATION_TAG_RE = re.compile(
    r"<AnswerGeneration>(.*?)</AnswerGeneration>", re.DOTALL | re.IGNORECASE
)
_ANSWER_LABEL_RE = re.compile(
    r"(?:^|\n)\s*(?:Exact Answer|Final Answer|Answer)\s*:\s*(.+?)(?:\n\n|\Z)",
    re.DOTALL,
)
_THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
def _extract_answer(text: str | None, thought: str | None) -> str | None:
    """Try increasingly loose patterns to find the terminal answer."""
    candidates = (
        (text or ""),
        (thought or ""),
    )
    for source in candidates:
        if not source:
            continue
        m = _FINAL_ANSWER_TAG_RE.search(source)
        if m:
            return m.group(1).strip()
        m = _ANSWER_TAG_RE.search(source)
        if m:
            inner = m.group(1).strip()
            ag = _ANSWER_GENERATION_TAG_RE.search(inner)
            if ag:
                return ag.group(1).strip()
            return inner
        m = _ANSWER_GENERATION_TAG_RE.search(source)
        if m:
            return m.group(1).strip()

    # Fallback: scan thought for `Final Answer:` / `Exact Answer:` / `Answer:`
    # patterns and take the last match.
    for source in candidates:
        if not source:
            continue
        last_match = None
        for m in _ANSWER_LABEL_RE.finditer(source):
            last_match = m
        if last_match:
            return last_match.group(1).strip()

    return None


def _complete_thought(thought: str | None) -> str | None:
    """Preserve the complete recorded thought or reject an empty value."""
    if not thought:
        return None
    cleaned = _THINK_TAG_RE.sub("", thought).strip()
    return cleaned or None


def rewrite(record: dict[str, Any], *, decoder, encoder) -> dict[str, Any] | None:
    md = record.get("metadata") or {}
    if md.get("source_dataset") != "regularizer-reasoning-tool":
        return record
    if md.get("task_type") != "agent_trace":
        return record

    try:
        decoded = decoder.decode(record["expectedResponse"])
    except Exception:
        return None
    if not isinstance(decoded, dict):
        return None

    thought_full = decoded.get("thought") or ""
    text_full = decoded.get("text") or ""
    if isinstance(text_full, list):
        # Defensive: native JSON can produce a list when the value contains a stray
        # bracket. Re-stringify so the regex pass works.
        text_full = "\n".join(str(x) for x in text_full)

    answer = _extract_answer(text_full if isinstance(text_full, str) else "", thought_full)
    if not answer:
        return None

    complete_thought = _complete_thought(thought_full)
    if complete_thought is None:
        return None
    new_payload = {"thought": complete_thought, "text": answer}
    try:
        new_payload = encoder.encode(new_payload)
    except Exception:
        return None

    new_md = dict(md)
    new_md["task_type"] = "reasoning_cot"
    new_md["_rewriter"] = "regularizer_reasoning_tool"

    new_record = dict(record)
    new_record["expectedResponse"] = new_payload
    new_record["metadata"] = new_md
    return new_record
