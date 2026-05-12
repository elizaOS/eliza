"""Compatibility character definition for SWE-bench tests and tooling."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


SWE_BENCH_MESSAGE_HANDLER_TEMPLATE = """
{{providers}}
{{recentMessages}}
<response>
<thought>Analyze the issue, inspect files, edit, test, and submit.</thought>
<actions>SEARCH_CODE|READ_FILE|LIST_FILES|EDIT_FILE|SUBMIT</actions>
<params>{"file_path": "...", "old_str": "...", "new_str": "..."}</params>
<text>Progress update</text>
</response>
"""

SWE_BENCH_REPLY_TEMPLATE = """
{{providers}}
<response>
<text>Reply with the current SWE-bench progress.</text>
</response>
"""


@dataclass
class SWEBenchCharacter:
    name: str = "SWE-Agent"
    username: str = "swe-agent"
    bio: str = "A systematic software engineering agent for SWE-bench tasks."
    system: str = "You are a systematic software engineering agent. Analyze before editing."
    settings: dict[str, Any] = field(default_factory=dict)
    templates: dict[str, str] = field(default_factory=dict)


def create_swe_bench_character(
    name: str = "SWE-Agent",
    model_name: str | None = None,
) -> SWEBenchCharacter:
    settings: dict[str, Any] = {
        "CHECK_SHOULD_RESPOND": False,
        "ACTION_PLANNING": True,
    }
    if model_name:
        settings["model"] = model_name
    return SWEBenchCharacter(
        name=name,
        settings=settings,
        templates={
            "messageHandlerTemplate": SWE_BENCH_MESSAGE_HANDLER_TEMPLATE,
            "replyTemplate": SWE_BENCH_REPLY_TEMPLATE,
        },
    )


swe_bench_character = create_swe_bench_character()
