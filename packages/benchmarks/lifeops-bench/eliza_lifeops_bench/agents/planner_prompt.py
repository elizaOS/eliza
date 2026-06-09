"""Planner prompt loading shared by direct LifeOpsBench agents."""

from __future__ import annotations

import json
import os

from ._openai_compat import LIFEOPS_TOOL_SYSTEM_PROMPT


def load_optimized_system_prompt() -> str:
    """Load a prompt override from LIFEOPS_PLANNER_PROMPT_FILE when present."""
    override_path = os.environ.get("LIFEOPS_PLANNER_PROMPT_FILE", "").strip()
    if not override_path or not os.path.exists(override_path):
        return LIFEOPS_TOOL_SYSTEM_PROMPT
    try:
        if override_path.endswith(".json"):
            with open(override_path, "r", encoding="utf-8") as fh:
                obj = json.load(fh)
            if isinstance(obj, dict) and isinstance(obj.get("prompt"), str):
                return obj["prompt"]
        else:
            with open(override_path, "r", encoding="utf-8") as fh:
                text = fh.read().strip()
            if text:
                return text
    except OSError:
        pass
    return LIFEOPS_TOOL_SYSTEM_PROMPT
