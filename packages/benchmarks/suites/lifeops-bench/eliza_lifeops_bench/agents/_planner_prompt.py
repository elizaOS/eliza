"""Loads an operator-selected planner prompt without masking broken artifacts."""

from __future__ import annotations

import json
import os
from pathlib import Path


def load_planner_system_prompt(default_prompt: str) -> str:
    """Return the configured planner prompt, or the default when unset.

    Setting ``LIFEOPS_PLANNER_PROMPT_FILE`` is an explicit operator choice.
    Missing, unreadable, malformed, or empty artifacts therefore fail fast
    instead of silently benchmarking a different prompt.
    """
    configured = os.environ.get("LIFEOPS_PLANNER_PROMPT_FILE", "").strip()
    if not configured:
        return default_prompt

    path = Path(configured).expanduser()
    try:
        text = path.read_text(encoding="utf-8")
    # error-policy:J2 Preserve the selected artifact path while retaining the filesystem cause.
    except OSError as exc:
        raise RuntimeError(
            f"failed to read LIFEOPS_PLANNER_PROMPT_FILE at {path}"
        ) from exc

    if path.suffix.casefold() == ".json":
        try:
            artifact = json.loads(text)
        # error-policy:J2 Identify the operator-selected artifact while retaining the decoder cause.
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"LIFEOPS_PLANNER_PROMPT_FILE at {path} is not valid JSON"
            ) from exc
        if not isinstance(artifact, dict):
            raise ValueError(
                f"LIFEOPS_PLANNER_PROMPT_FILE at {path} must contain a JSON object"
            )
        prompt = artifact.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError(
                f"LIFEOPS_PLANNER_PROMPT_FILE at {path} is missing a non-empty prompt"
            )
        return prompt.strip()

    prompt = text.strip()
    if not prompt:
        raise ValueError(
            f"LIFEOPS_PLANNER_PROMPT_FILE at {path} contains an empty prompt"
        )
    return prompt
