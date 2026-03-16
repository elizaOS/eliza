"""Action specs for plugin-prose."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ActionSpec:
    """Action specification."""

    name: str
    description: str
    similes: list[str] = field(default_factory=list)
    examples: list[list[dict[str, str]]] = field(default_factory=list)


ACTION_SPECS: dict[str, ActionSpec] = {
    "PROSE_RUN": ActionSpec(
        name="PROSE_RUN",
        description="Run an OpenProse program (.prose file). OpenProse is a programming language for AI sessions that orchestrates multi-agent workflows.",
        similes=["RUN_PROSE", "EXECUTE_PROSE", "PROSE_EXECUTE", "RUN_WORKFLOW", "ORCHESTRATE"],
        examples=[
            [
                {"role": "user", "content": "Run the hello world prose program"},
                {
                    "role": "assistant",
                    "content": "Loading the OpenProse VM and executing hello-world.prose...",
                },
            ],
            [
                {"role": "user", "content": "prose run examples/37-the-forge.prose"},
                {
                    "role": "assistant",
                    "content": "Starting The Forge - this program will orchestrate building a web browser from scratch.",
                },
            ],
        ],
    ),
    "PROSE_COMPILE": ActionSpec(
        name="PROSE_COMPILE",
        description="Validate an OpenProse program without executing it. Checks syntax and structure.",
        similes=["VALIDATE_PROSE", "CHECK_PROSE", "PROSE_VALIDATE", "PROSE_CHECK"],
        examples=[
            [
                {"role": "user", "content": "Check if my workflow.prose file is valid"},
                {
                    "role": "assistant",
                    "content": "Validating workflow.prose... The program is syntactically correct.",
                },
            ],
        ],
    ),
    "PROSE_HELP": ActionSpec(
        name="PROSE_HELP",
        description="Get help with OpenProse syntax, commands, and examples. Shows available programs and guidance.",
        similes=["PROSE_EXAMPLES", "PROSE_SYNTAX", "PROSE_DOCS", "HELP_PROSE"],
        examples=[
            [
                {"role": "user", "content": "How do I write a prose program?"},
                {
                    "role": "assistant",
                    "content": "OpenProse programs use sessions to spawn AI agents. Here's the basic syntax...",
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
