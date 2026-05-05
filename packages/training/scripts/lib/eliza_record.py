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
from dataclasses import dataclass, field
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
