"""Dynamic system prompt composer."""

from __future__ import annotations

import json
from pathlib import Path

from ..config import PromptConfig
from ..models.task import TaskDefinition

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent

_LEGACY_SYSTEM_PROMPT = (
    "You are a helpful personal assistant. "
    "Use the provided tools to complete the user's request. "
    "Think step by step before acting."
)


def _resolve_prompt_path(path_str: str) -> Path:
    p = Path(path_str)
    if p.is_absolute():
        return p
    return (_REPO_ROOT / p).resolve()


def _load_file(path_str: str | None, *, strict: bool) -> tuple[str, str | None]:
    """Load markdown content; return (content, resolved_path_str)."""
    if not path_str:
        return "", None

    p = _resolve_prompt_path(path_str)
    if not p.exists():
        if strict:
            raise FileNotFoundError(f"Prompt file not found: {p}")
        return "", str(p)
    return p.read_text(encoding="utf-8"), str(p)


def _render_tool_definitions(task: TaskDefinition, extra_tools: list | None = None) -> str:
    all_tools = list(task.tools) + (extra_tools or [])
    if not all_tools:
        return "\n".join([
            "## Tooling",
            "Tool availability (filtered by policy):",
            "Tool names are case-sensitive. Call tools exactly as listed.",
            "- None",
        ])

    lines = [
        "## Tooling",
        "Tool availability (filtered by policy):",
        "Tool names are case-sensitive. Call tools exactly as listed.",
    ]
    for tool in all_tools:
        lines.append(f"- {tool.name}: {tool.description}")
    lines.append("When a first-class tool exists for an action, use the tool directly.")
    return "\n".join(lines)


def _render_behavior_rules(cfg: PromptConfig) -> str:
    r = cfg.behavior_rules
    return "\n".join([
        "## Tool Call Style",
        "Default: do not narrate routine, low-risk tool calls (just call the tool).",
        "Narrate only when it helps: multi-step work, complex tasks, or sensitive actions.",
        "Keep narration brief and value-dense.",
        "Tool-call protocol is strict: use native API tool/function calls only.",
        "Never emit tool calls as plain text markup (for example: <tool_call>, <function=...>, <parameter=...>).",
        "If a tool is needed, issue a real tool call block instead of describing or simulating it in text.",
        "",
        "## Safety",
        f"- Safety: {r.safety}",
        f"- Tool Call Style: {r.tool_call_style}",
        f"- Reply Tags: {r.reply_tags}",
        f"- Silent Reply: {r.silent_reply}",
        f"- Heartbeat: {r.heartbeat}",
    ])


def _render_skills(cfg: PromptConfig) -> str:
    skills = cfg.skills.default
    lines = [
        "## Skills (mandatory)",
        "Before replying: scan <available_skills> entries.",
        "- If exactly one skill clearly applies: read its SKILL.md using the configured read tool, then follow it.",
        "- If multiple skills could apply: choose the most specific one, then read and follow it.",
        "- If none clearly apply: do not read any SKILL.md.",
        "Constraints: never read more than one skill up front; only read after selecting.",
    ]
    if cfg.skills.load_via_tool_call:
        lines.append(
            f"The full SKILL.md content must be loaded dynamically via tool call (`{cfg.skills.read_tool_name}`) using the skill path."
        )
    if not skills:
        lines.append("<available_skills>\n</available_skills>")
        return "\n".join(lines)

    lines.append("The following skills provide specialized instructions for specific tasks.")
    lines.append("<available_skills>")
    for s in skills:
        lines.append("  <skill>")
        lines.append(f"    <name>{s.name}</name>")
        lines.append(f"    <description>{s.description}</description>")
        lines.append(f"    <location>{s.path}</location>")
        lines.append("  </skill>")
    lines.append("</available_skills>")
    return "\n".join(lines)


def _render_workspace_blocks(cfg: PromptConfig) -> str:
    fcfg = cfg.files
    strict = cfg.strict_file_check
    agents, agents_path = _load_file(fcfg.agents_md, strict=strict)
    soul, soul_path = _load_file(fcfg.soul_md, strict=strict)
    user, user_path = _load_file(fcfg.user_md, strict=strict)
    tools, tools_path = _load_file(fcfg.tools_md, strict=strict)

    sections = ["## Workspace Files (injected)"]
    for title, content, p in [
        ("AGENTS.md", agents, agents_path),
        ("SOUL.md", soul, soul_path),
        ("USER.md", user, user_path),
        ("TOOLS.md", tools, tools_path),
    ]:
        if content:
            sections.append(f"### {title}")
            sections.append(f"Source: {p}")
            sections.append(content.strip())
        elif p:
            sections.append(f"### {title}")
            sections.append(f"Source: {p}")
            sections.append("[MISSING] Expected file not found or empty.")
    return "\n\n".join(sections)


def _render_tool_schemas(task: TaskDefinition, extra_tools: list | None = None) -> str:
    all_tools = list(task.tools) + (extra_tools or [])
    if not all_tools:
        return ""
    lines = ["## Tool Schemas", "Complete JSON Schema for available tools:"]
    for tool in all_tools:
        schema_json = json.dumps(tool.input_schema, ensure_ascii=False, indent=2)
        lines.append(f"- {tool.name}")
        lines.append("```json")
        lines.append(schema_json)
        lines.append("```")
    return "\n".join(lines)


def build_system_prompt(
    task: TaskDefinition,
    prompt_cfg: PromptConfig | None,
    *,
    extra_tools: list | None = None,
) -> str:
    """Build a dynamic system prompt from runtime config + task tools.

    Args:
        extra_tools: Additional tool specs (e.g. sandbox tools) to include
            in the tool definitions and schema sections of the prompt.
    """
    if prompt_cfg is None or not prompt_cfg.enabled:
        return _LEGACY_SYSTEM_PROMPT

    blocks: list[str] = [
        "You are a personal assistant running inside OpenClaw.",
    ]

    # Inject current date if mock_today is set
    if task.environment.mock_today:
        blocks.append(f"Current date: {task.environment.mock_today}")

    blocks.append(_render_tool_definitions(task, extra_tools))
    if prompt_cfg.include_tool_schema:
        blocks.append(_render_tool_schemas(task, extra_tools))
    blocks.append(_render_behavior_rules(prompt_cfg))
    blocks.append(_render_skills(prompt_cfg))
    blocks.append(_render_workspace_blocks(prompt_cfg))
    return "\n\n".join(blocks).strip()

