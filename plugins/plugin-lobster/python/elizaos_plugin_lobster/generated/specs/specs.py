"""Action specs for plugin-lobster."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ActionSpec:
    """Action specification."""

    name: str
    description: str
    similes: list[str] = field(default_factory=list)
    examples: list[list[dict[str, str]]] = field(default_factory=list)


ACTION_SPECS: dict[str, ActionSpec] = {
    "LOBSTER_RUN": ActionSpec(
        name="LOBSTER_RUN",
        description="Run a Lobster pipeline. Lobster is a workflow runtime for executing multi-step pipelines with approval checkpoints.",
        similes=["RUN_PIPELINE", "START_LOBSTER", "EXECUTE_PIPELINE", "LOBSTER_EXECUTE"],
        examples=[
            [
                {"role": "user", "content": "Run the deploy pipeline"},
                {
                    "role": "assistant",
                    "content": "Starting the deploy pipeline with Lobster...",
                },
            ],
            [
                {"role": "user", "content": "lobster run build-workflow"},
                {
                    "role": "assistant",
                    "content": "Executing the build-workflow pipeline...",
                },
            ],
        ],
    ),
    "LOBSTER_RESUME": ActionSpec(
        name="LOBSTER_RESUME",
        description="Resume a paused Lobster pipeline by approving or rejecting the pending step.",
        similes=[
            "APPROVE_PIPELINE",
            "RESUME_PIPELINE",
            "CONTINUE_LOBSTER",
            "LOBSTER_APPROVE",
        ],
        examples=[
            [
                {"role": "user", "content": "Yes, approve it"},
                {
                    "role": "assistant",
                    "content": "Approving the pending step and resuming the pipeline...",
                },
            ],
            [
                {"role": "user", "content": "No, cancel the deployment"},
                {
                    "role": "assistant",
                    "content": "Rejecting the step and cancelling the pipeline...",
                },
            ],
        ],
    ),
}


def require_action_spec(name: str) -> ActionSpec:
    """Get an action spec by name, raising if not found."""
    spec = ACTION_SPECS.get(name)
    if spec is None:
        raise KeyError(f"Action spec not found: {name}")
    return spec
