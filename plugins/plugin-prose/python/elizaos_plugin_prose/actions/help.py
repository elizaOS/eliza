"""PROSE_HELP action for getting OpenProse help and examples."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from elizaos_plugin_prose.generated.specs import require_action_spec
from elizaos_plugin_prose.services.prose_service import ProseService

logger = logging.getLogger(__name__)

spec = require_action_spec("PROSE_HELP")

QUICK_REFERENCE = """# OpenProse Quick Reference

OpenProse is a programming language for AI sessions. Programs define agents and sessions
that coordinate multi-agent workflows.

## Basic Syntax

```prose
# Program composition
program "name" version "1.0" {
    description "..."
    required_capabilities [capability1, capability2]
    
    define Agent researcher {
        system_prompt \"\"\"...\"\"\"
        tools [browse, search]
    }
    
    session main(inputs) -> outputs {
        // Use agents to perform tasks
        result <- researcher.complete("Research this topic")
        return { summary: result }
    }
}
```

## Commands

- `prose run <file.prose>` - Execute a program
- `prose compile <file.prose>` - Validate without running
- `prose help` - Show this help
- `prose examples` - List available examples

## Session Primitives

- `agent.complete(prompt)` - Run agent to completion
- `agent.stream(prompt)` - Stream agent response
- `session.spawn(inputs)` - Fork a subsession
- `await session_ref` - Wait for session result

## State Management

Programs can use different state backends:
- **filesystem** (default) - State stored in .prose/runs/
- **in-context** - State in conversation memory
- **sqlite** - SQLite database
- **postgres** - PostgreSQL database

## More Information

Use `prose examples` to see available example programs.
Each example demonstrates different OpenProse features.
"""


@dataclass
class ProseHelpAction:
    """Action to get help with OpenProse."""

    name: str = spec.name
    description: str = spec.description
    similes: list[str] = None  # type: ignore
    examples: list[list[dict[str, str]]] = None  # type: ignore

    def __post_init__(self) -> None:
        self.similes = spec.similes
        self.examples = spec.examples

    async def validate(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
    ) -> bool:
        """Validate if this action should be triggered."""
        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)
        lower = text.lower()

        if "prose help" in lower:
            return True
        if "prose examples" in lower:
            return True
        if "prose syntax" in lower:
            return True
        if "how do i write" in lower and "prose" in lower:
            return True
        if "what is openprose" in lower:
            return True
        if "openprose tutorial" in lower:
            return True

        return False

    async def handler(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: ProseService | None = None,
    ) -> dict[str, Any]:
        """Handle the PROSE_HELP action."""
        if service is None:
            service = ProseService()

        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)
        lower = text.lower()

        is_examples_request = "examples" in lower
        is_syntax_request = "syntax" in lower
        is_guidance_request = (
            "how do i write" in lower or "tutorial" in lower or "patterns" in lower
        )

        parts: list[str] = []

        # Always include quick reference (unless examples only)
        if not is_examples_request:
            help_doc = service.get_help()
            if help_doc and (is_syntax_request or is_guidance_request):
                parts.append(help_doc)
            else:
                parts.append(QUICK_REFERENCE)

        # Include authoring guidance if requested
        if is_guidance_request:
            guidance = service.get_authoring_guidance()
            if guidance.get("patterns"):
                parts.append("\n## Authoring Patterns\n")
                parts.append(guidance["patterns"])
            if guidance.get("antipatterns"):
                parts.append("\n## Antipatterns to Avoid\n")
                parts.append(guidance["antipatterns"])

        # List examples
        if is_examples_request:
            parts.append("# Available OpenProse Examples\n")

            examples = await service.list_examples()

            if examples:
                parts.append("The following example programs are available:\n")
                for ex in examples:
                    parts.append(f"- `{ex}`")
                parts.append('\nRun an example with: `prose run examples/<name>`')
            else:
                parts.append("No example programs found in the skills directory.")
                parts.append(
                    "\nExamples should be placed in the `examples/` subdirectory of the prose skill."
                )

            # Add some inline examples
            parts.append("\n## Example Programs\n")
            parts.append("Here are some example patterns you can use:\n")

            parts.append("### Hello World\n")
            parts.append(
                '''```prose
program "hello" version "1.0" {
    description "A simple hello world program"
    
    define Agent greeter {
        system_prompt "You are a friendly greeter."
    }
    
    session main() -> result {
        greeting <- greeter.complete("Say hello to the user")
        return { message: greeting }
    }
}
```
'''
            )

            parts.append("### Multi-Agent Research\n")
            parts.append(
                '''```prose
program "research" version "1.0" {
    description "Multi-agent research workflow"
    required_capabilities [browse, search]
    
    define Agent researcher {
        system_prompt "You research topics thoroughly."
        tools [search, browse]
    }
    
    define Agent writer {
        system_prompt "You write clear summaries."
    }
    
    session main(topic: string) -> report {
        findings <- researcher.complete("Research: " + topic)
        summary <- writer.complete("Summarize: " + findings)
        return { topic: topic, summary: summary }
    }
}
```
'''
            )

        logger.info(f"Provided help for: {lower}")

        return {
            "success": True,
            "text": "\n".join(parts),
            "data": {},
        }
