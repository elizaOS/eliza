"""Rewriter for nubilio-trajectories.

Original shape (all flagged `agent_trace`): the canonical eliza system prompt
has been baked into `currentMessage.content`, and several unrelated runtime
sub-tasks (message_handler, reflection, knowledge-provider selector, provider
selector) coexist under the same task label.

Strategy:
  1. Detect sub-task by stable prompt-prefix markers.
  2. Move the entire prompt body to `metadata.system_prompt`.
  3. Reduce `currentMessage.content` to only the actual user-visible turn.
     For the message_handler branch we extract the body after the
     `# Received Message` / `# Focus your response` separator.
     For the other branches there is no real "user message"; we set
     `currentMessage.content` to a synthetic placeholder describing the task
     so the record stays valid for the trainer.
  4. Keep `expectedResponse` unchanged but verify it round-trips through TOON.

If the record cannot be classified into one of the four supported sub-tasks
it is annotated with `_needs_human_review: True` and routed to a separate
review file by the orchestrator (the rewriter still returns the record so it
isn't silently dropped — `run_all.py` filters review records out of the main
output stream).
"""

from __future__ import annotations

from typing import Any

# Sub-task prompt markers, ordered most specific → least specific.
# The first marker that appears anywhere in the prompt body wins.
_DISPATCH = (
    (
        "should_use_knowledge_providers",
        "Decide whether the assistant should consult uploaded-document or knowledge providers",
    ),
    (
        "reflection",
        "Generate Agent Reflection",
    ),
    (
        "should_call_providers",
        "Decide whether any providers should be called",
    ),
    (
        "message_handler",
        "Generate dialog and actions",
    ),
    (
        "message_handler",
        "Generate dialog for the character",
    ),
    (
        "message_handler",
        "task: Write the next assistant reply",
    ),
)

# A few additional prompt prefixes have a clean structure but don't fit the
# four canonical sub-tasks; they're flagged for human review so we can decide
# later whether to add a dedicated task type or drop them.
_REVIEW_MARKERS = (
    "Select the single best action for this turn",
    "Generate task completion criteria",
    "Continue helping the user after reviewing the latest action",
    "Extract Long-Term Memory",
    "You are scoring how relevant each candidate skill",
    "You are repairing an action-planner output",
    "You are an AI orchestrator about to launch",
    "Write the assistant's user-facing reply for a LifeOps",
    "Plan the LifeOps response",
    "Plan the OWNER_INBOX subaction",
    "Plan the OWNER_CALENDAR subaction",
    "Plan the BACKGROUND JOB action",
    "Plan the calendar action",
    "Plan the next step for a LifeOps",
    "Resolve this calendar read intent",
    "Resolve whether this calendar request",
    "Recover the core LifeOps intent",
    "Extract task management intent",
    "Extract trigger details",
    "Extract Gmail parameters",
    "Extract or recover the Gmail compose draft",
    "You are recovering from an internal structured-output failure",
    "Decide how the assistant should interpret the user",
    "Split the following text into",
)


def _classify(prompt: str) -> tuple[str | None, str | None]:
    """Return (task_type, marker) or (None, None) when no rule matches.

    A prompt is considered review-only when it starts with one of the
    `_REVIEW_MARKERS` but matches no canonical dispatch entry.
    """
    for task_type, marker in _DISPATCH:
        if marker in prompt:
            return task_type, marker
    head = prompt[:200]
    for marker in _REVIEW_MARKERS:
        if marker in head:
            return None, marker
    return None, None


# When the prompt is the canonical message_handler, the actual user message
# appears after one of these section separators.
_USER_MSG_SEPARATORS = (
    "# Received Message\n",
    "# Focus your response\n",
)


def _extract_user_turn(prompt: str) -> str | None:
    """Best-effort extraction of the actual user message from the message_handler
    prompt body. Returns None when no reliable separator is found."""
    for sep in _USER_MSG_SEPARATORS:
        idx = prompt.find(sep)
        if idx == -1:
            continue
        body = prompt[idx + len(sep) :]
        # Trim at the next templated section (e.g. `# Focus your response`,
        # `# Recent Action History`, `rules[`, `formatting:`, `output:`).
        cut_markers = (
            "\n# Focus your response\n",
            "\n# Recent Action History\n",
            "\nrules[",
            "\nformatting:\n",
            "\noutput:\n",
        )
        cut_idx = len(body)
        for cm in cut_markers:
            j = body.find(cm)
            if j != -1 and j < cut_idx:
                cut_idx = j
        body = body[:cut_idx].strip()
        if body:
            return body
    return None


def rewrite(record: dict[str, Any], *, decoder, encoder) -> dict[str, Any] | None:
    md = record.get("metadata") or {}
    if md.get("source_dataset") != "nubilio-trajectories":
        return record

    cm = record.get("currentMessage") or {}
    body = cm.get("content")
    if not isinstance(body, str) or not body.strip():
        return None

    task_type, marker = _classify(body)

    new_md = dict(md)
    new_md["_rewriter"] = "nubilio_trajectories"
    new_md["system_prompt"] = body

    if task_type is None:
        # Either an unknown shape entirely or a known-but-out-of-scope shape.
        new_md["_needs_human_review"] = True
        new_md["_rewriter_branch"] = (
            f"review:{marker[:60]}" if marker else "review:unknown"
        )
        new_record = dict(record)
        new_record["metadata"] = new_md
        return new_record

    new_md["task_type"] = task_type
    new_md["_rewriter_branch"] = task_type

    new_cm = dict(cm)
    if task_type == "message_handler":
        user_turn = _extract_user_turn(body)
        if user_turn:
            new_cm["content"] = user_turn
        else:
            new_md["_needs_human_review"] = True
            new_cm["content"] = ""
    else:
        # Selector tasks have no genuine user turn — the whole prompt is the
        # decision context. Use a stable synthetic content string so the
        # trainer can still render the prompt.
        synthetic = {
            "should_use_knowledge_providers": (
                "Decide whether to consult uploaded-document or knowledge providers."
            ),
            "should_call_providers": (
                "Decide whether any providers should be called before replying."
            ),
            "reflection": (
                "Reflect on the recent agent interactions and extract facts/relationships."
            ),
        }
        new_cm["content"] = synthetic.get(task_type, "")

    new_record = dict(record)
    new_record["currentMessage"] = new_cm
    new_record["metadata"] = new_md
    return new_record
