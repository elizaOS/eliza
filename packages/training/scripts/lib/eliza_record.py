"""Canonical eliza record — matches scambench `eliza` config exactly.

Shape:
    {
      "roomName":         "string",
      "agentId":          "string",
      "memoryEntries":    [{"role","speaker","content","channel"}],
      "currentMessage":   {"role","speaker","content","channel"},
      "expectedResponse": "string  (TOON for structured tasks, plain text for replies)",
      "availableActions": ["RESPOND" | "IGNORE" | "STOP" | "REPLY"
                            | "SHELL_COMMAND" | "TASK_CALL"
                            | "MUTE_ROOM" | "UNMUTE_ROOM"
                            | "FOLLOW_ROOM" | "UNFOLLOW_ROOM"
                            | ... custom strings ...],
      "metadata":         {...source-specific extras (task_type, toolSpecs,
                              language, scenario_category, ...)}
    }

No extra top-level fields. Every adapter-specific extra rides under
`metadata`.

The supervised target is `expectedResponse`. For structured tasks (routing,
tool calls, shell commands, multi-step decisions) the trainer expects
`expectedResponse` to be a TOON document; for plain replies it's the
assistant text directly.

`metadata.task_type` selects the prompt template the trainer renders into
the system message at training time. See
`scripts/format_for_training.py`.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


# Canonical action vocabulary. Adapters MAY emit other action strings (custom
# tool/skill names) but routing/shell/task-call decisions must use these.
ACTION_RESPOND = "RESPOND"
ACTION_IGNORE = "IGNORE"
ACTION_STOP = "STOP"
ACTION_REPLY = "REPLY"
ACTION_SHELL_COMMAND = "SHELL_COMMAND"
ACTION_TASK_CALL = "TASK_CALL"
ACTION_MUTE_ROOM = "MUTE_ROOM"
ACTION_UNMUTE_ROOM = "UNMUTE_ROOM"
ACTION_FOLLOW_ROOM = "FOLLOW_ROOM"
ACTION_UNFOLLOW_ROOM = "UNFOLLOW_ROOM"

ROUTING_ACTIONS = [ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP]
REPLY_ACTIONS = [ACTION_REPLY, ACTION_IGNORE]


# Single source of truth for the literal default-thought strings the legacy
# adapters injected into records that lacked a real reasoning trace. The
# 7M-record corpus contained millions of copies of these phrases as the
# supervised target, which trained the model to emit them verbatim instead
# of producing a real chain-of-thought.
#
# All scrubbing tools (preflight gate, transform_fix_default_thoughts,
# transform_purge_default_thoughts, scan_trivial_thoughts, repack_v9,
# synthesize_reasoning_round3) MUST import this constant rather than
# re-declare the list — otherwise the sets drift and the leak comes back.
#
# Order: the two literals from the original adapter defaults first, then the
# seven trivial-thought placeholders the round-2/round-3 synth used as
# stand-ins. Add new entries here and nowhere else.
DEFAULT_THOUGHT_LEAKS: tuple[str, ...] = (
    "Reply to the user.",
    "Call the tool to satisfy the request.",
    "Let me work through this step by step.",
    "Let me handle this request.",
    "Let me figure out the correct tool and parameters.",
    "Processing the user's request now.",
    "Got the data. Let me figure out how to proceed.",
    "Information retrieved. Let me process this for the user.",
    "The tool returned data. Let me review it.",
)


def is_default_thought_leak(thought: str | None) -> bool:
    """Return True iff `thought` (after quote/whitespace strip) matches one
    of the canonical leak literals. Empty / None thoughts are NOT leaks —
    the runtime tolerates an empty `<thought></thought>`, only the literal
    placeholders pollute training."""
    if thought is None:
        return False
    s = thought.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        s = s[1:-1].strip()
    return s in DEFAULT_THOUGHT_LEAKS


def stable_id(*parts: object) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:24]


@dataclass
class ElizaRecord:
    """Flat eliza-format training record. One row = one supervised example."""

    roomName: str
    agentId: str
    memoryEntries: list[dict[str, Any]]
    currentMessage: dict[str, Any]
    expectedResponse: str
    availableActions: list[str]
    metadata: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "roomName": self.roomName,
            "agentId": self.agentId,
            "memoryEntries": self.memoryEntries,
            "currentMessage": self.currentMessage,
            "expectedResponse": self.expectedResponse,
            "availableActions": self.availableActions,
            "metadata": self.metadata,
        }

    def is_valid(self) -> tuple[bool, str]:
        if not self.roomName:
            return False, "missing roomName"
        if not self.agentId:
            return False, "missing agentId"
        if not isinstance(self.currentMessage, dict) or not self.currentMessage.get("content"):
            return False, "currentMessage missing content"
        if not self.expectedResponse:
            return False, "missing expectedResponse"
        if not self.metadata.get("task_type"):
            return False, "missing metadata.task_type"
        if not self.metadata.get("source_dataset"):
            return False, "missing metadata.source_dataset"
        return True, ""

    def to_jsonl(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, separators=(",", ":"))


def build(
    *,
    roomName: str,
    agentId: str,
    expectedResponse: str,
    task_type: str,
    source_dataset: str,
    license: str = "unknown",
    split: str = "train",
    memoryEntries: list[dict[str, Any]] | None = None,
    currentMessage: dict[str, Any] | None = None,
    availableActions: list[str] | None = None,
    extra_metadata: dict[str, Any] | None = None,
) -> ElizaRecord:
    """Convenience builder that sets the required metadata keys."""
    md: dict[str, Any] = {
        "task_type": task_type,
        "source_dataset": source_dataset,
        "license": license,
        "split": split,
    }
    if extra_metadata:
        md.update(extra_metadata)
    return ElizaRecord(
        roomName=roomName,
        agentId=agentId,
        memoryEntries=memoryEntries or [],
        currentMessage=currentMessage or {},
        expectedResponse=expectedResponse,
        availableActions=availableActions or [],
        metadata=md,
    )
