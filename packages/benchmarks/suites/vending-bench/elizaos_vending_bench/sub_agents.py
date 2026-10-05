"""
Sub-agents

The paper distinguishes the main agent (planning, time-control, communication)
from physical/on-site sub-agents that handle stocking/pricing, plus delegated
sub-agents for email correspondence and web research. The main agent
``run_sub_agent``s with a free-form instruction string; the sub-agent uses its
OWN context window and a restricted tool set, then returns a summary.

Our implementation models the two delegated sub-agents (email + research)
explicitly. Each sub-agent receives a fresh prompt history and (when an
``LLMProvider`` is supplied) makes its own LLM call. Without an LLM, the
sub-agents fall back to deterministic helpers so the harness can run offline.

NOTE: We deliberately keep this simpler than the paper's full multi-agent
graph — the on-site "physical" sub-agent is absorbed into the structured
``RESTOCK_SLOT`` / ``SET_PRICE`` / ``COLLECT_CASH`` actions exposed on the main
agent (the paper's split is mostly organisational for the LLM, not an
information barrier).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from elizaos_vending_bench.environment import VendingEnvironment


class SubAgentLLM(Protocol):
    """Same shape as :class:`elizaos_vending_bench.agent.LLMProvider`."""

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        ...


@dataclass
class SubAgentReport:
    """Structured return value from a sub-agent invocation."""

    name: str
    task: str
    result: str
    tool_calls: list[str] = field(default_factory=list)
    tokens_used: int = 0
    error: str | None = None


# =====================================================================
class EmailSubAgent:
    """Handles supplier correspondence on behalf of the main agent.

    Tools available to this sub-agent: ``send_email``, ``read_email``,
    ``check_deliveries`` (read-only view of pending orders), and notepad I/O.
    Its OWN context window — never shares the main agent's prompt history.
    """

    SYSTEM_PROMPT = (
        "You are an email sub-agent for a vending-machine business. Your job is "
        "to handle correspondence with wholesale suppliers. You have a SEPARATE "
        "context window from the main agent — you must rely only on the task "
        "string you were given plus the contents of the inbox/outbox.\n\n"
        "Tools you may call (respond with JSON containing 'action'):\n"
        "  SEND_EMAIL {to, subject, body}\n"
        "  READ_EMAIL {only_unread?: bool}\n"
        "  NOTEPAD_WRITE {text}\n"
        "  CHECK_DELIVERIES {}\n"
        "  FINISH {summary}\n\n"
        "Be concise and end with FINISH once the task is handled."
    )

    def __init__(self, env: VendingEnvironment, llm: SubAgentLLM | None = None) -> None:
        self.env = env
        self.llm = llm

    async def run(self, task: str, max_steps: int = 6) -> SubAgentReport:
        report = SubAgentReport(name="email_sub_agent", task=task, result="")
        if self.llm is None:
            return self._run_heuristic(task, report)
        # Real LLM path.
        history: list[str] = [f"TASK: {task}"]
        for _ in range(max_steps):
            user = "\n".join(history) + "\nNext action:"
            try:
                response, tokens = await self.llm.generate(self.SYSTEM_PROMPT, user, 0.0)
            except Exception as exc:  # pragma: no cover - defensive
                report.error = f"sub-agent LLM error: {exc}"
                break
            report.tokens_used += tokens
            history.append(f"AGENT: {response}")
            action, payload = _parse_subagent_action(response)
            if action == "FINISH":
                report.result = payload.get("summary", "(no summary)")
                report.tool_calls.append("FINISH")
                break
            result = self._dispatch(action, payload)
            report.tool_calls.append(action or "INVALID")
            history.append(f"TOOL: {result}")
        if not report.result:
            report.result = "Sub-agent did not call FINISH; partial trace recorded."
        return report

    # ----------------------------------------------------------- heuristic
    def _run_heuristic(self, task: str, report: SubAgentReport) -> SubAgentReport:
        """Deterministic heuristic email correspondence.

        Recognises a small set of intents from the task string so the harness
        can run smoke tests offline:

        - "inquire about <product>" -> sends a price-check email to the
          appropriate supplier.
        - "follow up" / "check inbox" -> reads the inbox.
        - default -> emails every supplier with a generic catalog request.
        """
        lower = task.lower()
        env = self.env
        suppliers = env.suppliers

        if "follow up" in lower or "check inbox" in lower or "read" in lower:
            result = env.action_read_email()
            report.tool_calls.append("READ_EMAIL")
            report.result = "Inbox checked.\n" + result[:1500]
            return report

        # Find any product names mentioned.
        mentioned: list[str] = []
        for pid, product in env.products.items():
            if pid in lower or product.name.lower() in lower:
                mentioned.append(pid)

        sent = 0
        for supplier in suppliers:
            relevant = [pid for pid in supplier.products if not mentioned or pid in mentioned]
            if not relevant:
                continue
            qty_hint = ", ".join(f"~{20} units of {pid}" for pid in relevant[:3])
            body = (
                f"Hello {supplier.name},\n\n"
                f"For our vending machine restock we are interested in {qty_hint}. "
                f"Please send your current wholesale price quote and lead time.\n\n"
                f"Thanks,\nVending Operator"
            )
            env.action_send_email(
                to=supplier.email,
                subject="Wholesale inquiry",
                body=body,
            )
            report.tool_calls.append("SEND_EMAIL")
            sent += 1

        report.result = f"Sent {sent} inquiry email(s). Replies will arrive on the next day."
        return report

    def _dispatch(self, action: str | None, payload: dict[str, str]) -> str:
        if action == "SEND_EMAIL":
            return self.env.action_send_email(
                to=str(payload.get("to", "")),
                subject=str(payload.get("subject", "")),
                body=str(payload.get("body", "")),
            )
        if action == "READ_EMAIL":
            return self.env.action_read_email()
        if action == "NOTEPAD_WRITE":
            return self.env.action_notepad_write(str(payload.get("text", "")))
        if action == "CHECK_DELIVERIES":
            return self.env.action_check_deliveries()
        return f"Unknown sub-agent action: {action!r}"


# =====================================================================
class ResearchSubAgent:
    """Handles web research on behalf of the main agent.

    Tools available to this sub-agent: ``search_web``, ``notepad_write``,
    ``notepad_read``. Its OWN context window.
    """

    SYSTEM_PROMPT = (
        "You are a research sub-agent for a vending-machine business. Use the "
        "search_web tool to gather information that helps the main agent make "
        "decisions about suppliers, pricing, weather, and product demand. You "
        "have a SEPARATE context window — produce a concise written summary "
        "via FINISH once you've gathered enough.\n\n"
        "Tools (respond with JSON containing 'action'):\n"
        "  SEARCH_WEB {query}\n"
        "  NOTEPAD_WRITE {text}\n"
        "  NOTEPAD_READ {}\n"
        "  FINISH {summary}\n"
    )

    def __init__(self, env: VendingEnvironment, llm: SubAgentLLM | None = None) -> None:
        self.env = env
        self.llm = llm

    async def run(self, task: str, max_steps: int = 5) -> SubAgentReport:
        report = SubAgentReport(name="research_sub_agent", task=task, result="")
        if self.llm is None:
            return self._run_heuristic(task, report)
        history: list[str] = [f"TASK: {task}"]
        for _ in range(max_steps):
            user = "\n".join(history) + "\nNext action:"
            try:
                response, tokens = await self.llm.generate(self.SYSTEM_PROMPT, user, 0.0)
            except Exception as exc:  # pragma: no cover - defensive
                report.error = f"sub-agent LLM error: {exc}"
                break
            report.tokens_used += tokens
            history.append(f"AGENT: {response}")
            action, payload = _parse_subagent_action(response)
            if action == "FINISH":
                report.result = payload.get("summary", "(no summary)")
                report.tool_calls.append("FINISH")
                break
            result = self._dispatch(action, payload)
            report.tool_calls.append(action or "INVALID")
            history.append(f"TOOL: {result}")
        if not report.result:
            report.result = "Sub-agent did not call FINISH; partial trace recorded."
        return report

    def _run_heuristic(self, task: str, report: SubAgentReport) -> SubAgentReport:
        env = self.env
        queries = [task] if task else ["wholesale suppliers vending"]
        # Add a couple of follow-up topical queries to demonstrate use of the tool.
        lower = task.lower()
        if "pricing" in lower or "price" in lower:
            queries.append("vending machine retail markup norms")
        if "weather" in lower or "season" in lower:
            queries.append("office vending weather season demand")
        bullets: list[str] = []
        for q in queries[:3]:
            rendered = env.action_search_web(q)
            report.tool_calls.append("SEARCH_WEB")
            # Keep just the first result snippet for the summary.
            first_snippet = ""
            for line in rendered.splitlines():
                line = line.strip()
                if line.startswith("[1]"):
                    first_snippet = line
                elif line.startswith("https://") and first_snippet:
                    first_snippet = first_snippet + " " + line
                elif first_snippet and line and not line.startswith("==="):
                    first_snippet = first_snippet + " — " + line
                    break
            bullets.append(f"- {q}: {first_snippet or '(no result)'}")
        summary = "Research summary:\n" + "\n".join(bullets)
        env.action_notepad_write(summary)
        report.tool_calls.append("NOTEPAD_WRITE")
        report.result = summary
        return report

    def _dispatch(self, action: str | None, payload: dict[str, str]) -> str:
        if action == "SEARCH_WEB":
            return self.env.action_search_web(str(payload.get("query", "")))
        if action == "NOTEPAD_WRITE":
            return self.env.action_notepad_write(str(payload.get("text", "")))
        if action == "NOTEPAD_READ":
            return self.env.action_notepad_read()
        return f"Unknown sub-agent action: {action!r}"


# =====================================================================
_ACTION_RE = re.compile(r'"action"\s*:\s*"([A-Z_]+)"')


def _parse_subagent_action(response: str) -> tuple[str | None, dict[str, str]]:
    """Very small JSON parser for sub-agent responses.

    Falls back to None if the response isn't well-formed JSON; the heuristic
    paths above never reach this parser.
    """
    import json

    text = response.strip()
    # Strip markdown fences.
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.startswith("json\n"):
                text = text[len("json\n"):]
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = _ACTION_RE.search(text)
        if not match:
            return None, {}
        return match.group(1), {}
    if not isinstance(data, dict):
        return None, {}
    action = str(data.get("action") or data.get("name") or "").strip().upper()
    payload: dict[str, str] = {}
    for k, v in data.items():
        if k in ("action", "name"):
            continue
        payload[str(k)] = "" if v is None else str(v)
    return (action or None), payload
