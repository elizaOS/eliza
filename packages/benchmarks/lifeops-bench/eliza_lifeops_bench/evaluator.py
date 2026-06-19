"""LLM-driven evaluator: simulates the user persona and judges live-mode satisfaction.

Two distinct LLM clients power the evaluator:

* The **simulated-user client** (typically Cerebras gpt-oss-120b) plays the
  scenario persona. It receives the hidden goal in its system prompt and is
  instructed to reveal it gradually, the way a real user would.

* The **judge client** (typically Anthropic Claude Opus) decides when the
  executor has satisfied the persona's goal. It MUST be a different model
  family / instance from the simulated user to avoid self-agreement bias —
  if the same model both plays the user and grades the run, "satisfied"
  collapses into "the user said 'thanks'", which over-counts shallow wins.

The evaluator carries two cost ledgers (``simulated_user_cost_usd`` and
``judge_cost_usd``) so the runner can split agent spend from eval spend in
``BenchmarkResult``. Operators need that split — without it we cannot
answer "how much of this $50 run was the executor vs. the judge?".
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .clients.base import BaseClient, ClientCall
from .types import FirstQuestionFallback, MessageTurn, Scenario

if TYPE_CHECKING:
    from .lifeworld import LifeWorld


def _parse_iso_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.rstrip("Z")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _coerce_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "y", "satisfied", "pass", "1"}:
            return True
        if normalized in {"false", "no", "n", "failed", "fail", "0"}:
            return False
    return None


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    stripped = stripped[3:].lstrip()
    if stripped.startswith("json"):
        stripped = stripped[4:].lstrip()
    if stripped.endswith("```"):
        stripped = stripped[:-3].rstrip()
    return stripped


def _summarize_world_state(world_state: "LifeWorld") -> str:
    counts = world_state.counts()
    lines = [
        f"Benchmark clock: {world_state.now_iso}",
        "World heartbeat: this is the latest live snapshot before the next user reply.",
        (
            "Entity counts: "
            f"emails={counts['email']}, "
            f"calendar_events={counts['calendar_event']}, "
            f"reminders={counts['reminder']}, "
            f"conversations={counts['conversation']}, "
            f"contacts={counts['contact']}"
        ),
    ]

    email_items = sorted(
        world_state.emails.values(),
        key=lambda email: (
            _parse_iso_utc(email.received_at or email.sent_at) or datetime.min.replace(
                tzinfo=timezone.utc
            ),
            email.id,
        ),
        reverse=True,
    )[:3]
    if email_items:
        lines.append("Recent emails:")
        for email in email_items:
            lines.append(
                f"  - {email.folder} from {email.from_email}: {email.subject}"
            )

    calendar_items = sorted(
        world_state.calendar_events.values(),
        key=lambda event: (
            _parse_iso_utc(event.start) or datetime.max.replace(tzinfo=timezone.utc),
            event.id,
        ),
    )[:3]
    if calendar_items:
        lines.append("Upcoming calendar events:")
        for event in calendar_items:
            lines.append(
                f"  - {event.start} [{event.status}] {event.title}"
            )

    reminder_items = sorted(
        world_state.reminders.values(),
        key=lambda reminder: (
            _parse_iso_utc(reminder.due_at) or datetime.max.replace(tzinfo=timezone.utc),
            reminder.id,
        ),
    )[:3]
    if reminder_items:
        lines.append("Pending reminders:")
        for reminder in reminder_items:
            due = reminder.due_at or "unscheduled"
            lines.append(f"  - {due} {reminder.title}")

    return "\n".join(lines)


def _parse_judge_verdict(content: str | None) -> tuple[bool, str]:
    raw = (content or "").strip()
    if not raw:
        return False, "empty judge response"

    for candidate in (raw, _strip_code_fence(raw)):
        if not candidate:
            continue
        json_candidate = candidate
        if not json_candidate.lstrip().startswith("{"):
            start = json_candidate.find("{")
            end = json_candidate.rfind("}")
            if start != -1 and end > start:
                json_candidate = json_candidate[start : end + 1]
            else:
                json_candidate = ""
        if not json_candidate:
            continue
        try:
            parsed = json.loads(json_candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        verdict_value = parsed.get("satisfied")
        if verdict_value is None:
            verdict_value = parsed.get("verdict")
        if verdict_value is None:
            verdict_value = parsed.get("answer")
        if verdict_value is None:
            verdict_value = parsed.get("status")
        satisfied = _coerce_bool(verdict_value)
        if satisfied is None:
            continue
        reason_value = parsed.get("reason")
        if reason_value is None:
            reason_value = parsed.get("explanation")
        if reason_value is None:
            reason_value = parsed.get("why")
        reason = str(reason_value).strip() if reason_value is not None else ""
        return satisfied, reason or raw

    first_line = raw.splitlines()[0].strip()
    match = re.match(r"^(YES|NO)\b[:\s\-—]*(.*)$", first_line, flags=re.IGNORECASE)
    if match:
        satisfied = match.group(1).upper() == "YES"
        reason = match.group(2).strip()
        if not reason:
            tail = [line.strip() for line in raw.splitlines()[1:] if line.strip()]
            reason = " ".join(tail)
        return satisfied, reason or raw

    return False, raw


class LifeOpsEvaluator:
    """Plays the simulated user and judges agent satisfaction in LIVE mode.

    Construction enforces that the simulated-user client and the judge
    client are distinct instances. Use different model identifiers (and
    ideally different providers) to avoid self-agreement bias.
    """

    def __init__(
        self,
        simulated_user_client: BaseClient,
        judge_client: BaseClient,
    ) -> None:
        if simulated_user_client is judge_client:
            raise ValueError(
                "LifeOpsEvaluator: simulated_user_client and judge_client must be "
                "different instances — sharing one client causes self-agreement bias "
                "in satisfaction judgments."
            )
        if simulated_user_client.model_name == judge_client.model_name:
            raise ValueError(
                "LifeOpsEvaluator: simulated_user_client and judge_client must use "
                f"different model identifiers; both are '{simulated_user_client.model_name}'."
            )
        self.simulated_user_client = simulated_user_client
        self.judge_client = judge_client
        self.simulated_user_cost_usd: float = 0.0
        self.judge_cost_usd: float = 0.0

    @property
    def cost_usd(self) -> float:
        """Total evaluator spend (simulated user + judge)."""
        return self.simulated_user_cost_usd + self.judge_cost_usd

    def reset_cost(self) -> None:
        """Zero both cost ledgers; called by the runner per-scenario when needed."""
        self.simulated_user_cost_usd = 0.0
        self.judge_cost_usd = 0.0

    # ------------------------------------------------------------------
    # Simulated user
    # ------------------------------------------------------------------

    async def simulate_user_turn(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> MessageTurn:
        """Generate the next user message in LIVE mode.

        The system prompt instructs the simulated-user model to:
          * play the persona by name + traits + style,
          * pursue the hidden goal but reveal it naturally over turns,
          * not paste the goal verbatim,
          * decide on its own when to refuse / accept / refine.
        """
        turn_number = sum(1 for t in history if t.role == "user") + 1
        remaining_patience = max(0, scenario.persona.patience_turns - turn_number)
        world_snapshot = _summarize_world_state(world_state)

        system_prompt = self._build_user_simulation_prompt(
            scenario, turn_number, remaining_patience, world_snapshot
        )
        history_messages = self._render_history_for_user(history)

        call = ClientCall(
            messages=[
                {"role": "system", "content": system_prompt},
                *history_messages,
            ],
            temperature=0.7,
            max_tokens=400,
        )
        response = await self.simulated_user_client.complete(call)
        if response.cost_usd is not None:
            # Unpriced models skip the accumulator so simulated-user spend
            # tracks only billable calls — "unpriced" is not the same as
            # "free" (AGENTS.md Cmd #8).
            self.simulated_user_cost_usd += response.cost_usd
        content = (response.content or "").strip()
        if not content:
            content = "(no response)"
        return MessageTurn(role="user", content=content)

    # ------------------------------------------------------------------
    # Judge
    # ------------------------------------------------------------------

    async def judge_satisfaction(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> tuple[bool, str]:
        """Ask the judge model whether the executor satisfied the persona's goal.

        Returns ``(satisfied, reason)``. The judge is told to be conservative:
        only return YES if the persona's goal is meaningfully addressed in the
        spirit of what was asked. A response of "I'll get to it" is NOT
        satisfaction — the goal must actually be advanced.
        """
        prompt = self._build_judge_prompt(scenario, history, world_state)
        call = ClientCall(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=200,
        )
        response = await self.judge_client.complete(call)
        if response.cost_usd is not None:
            # Unpriced models skip the accumulator (AGENTS.md Cmd #8).
            self.judge_cost_usd += response.cost_usd
        satisfied, reason = _parse_judge_verdict(response.content)
        return satisfied, reason

    # ------------------------------------------------------------------
    # STATIC-mode helpers (kept for back-compat with existing runner)
    # ------------------------------------------------------------------

    async def apply_first_question_fallback(
        self,
        scenario: Scenario,
        agent_message: str,
    ) -> MessageTurn | None:
        """STATIC-mode only — return the canned answer if the agent opened with a clarifier.

        LIVE mode never calls this; the simulated user just answers naturally.
        """
        fallback = scenario.first_question_fallback
        if fallback is None:
            return None
        if not self._looks_like_clarifying_question(agent_message, fallback):
            return None
        return MessageTurn(role="user", content=fallback.canned_answer)

    # ------------------------------------------------------------------
    # Prompt construction
    # ------------------------------------------------------------------

    def _build_user_simulation_prompt(
        self,
        scenario: Scenario,
        turn_number: int,
        remaining_patience: int,
        world_snapshot: str,
    ) -> str:
        persona = scenario.persona
        traits = ", ".join(persona.traits)
        return (
            f"You are role-playing {persona.name}, a real person talking to an AI life-assistant.\n"
            f"\n"
            f"Background: {persona.background}\n"
            f"Traits: {traits}\n"
            f"Communication style: {persona.communication_style}\n"
            f"\n"
            f"Your underlying goal in this conversation:\n"
            f"  {scenario.instruction}\n"
            f"\n"
            f"Rules for staying in character:\n"
            f"  - DO NOT paste the goal verbatim. Reveal it naturally, the way "
            f"    a real person would (one piece at a time, in your own words).\n"
            f"  - Stay in your persona's voice and style at all times.\n"
            f"  - If the assistant asks a clarifying question, answer it in character.\n"
            f"  - If the assistant proposes something, evaluate it like a real person would: "
            f"    accept what fits, reject what doesn't, refine when useful.\n"
            f"  - When your goal is meaningfully met, signal acceptance briefly "
            f"    (e.g. 'great, thanks', 'perfect', 'works for me'). Don't be effusive.\n"
            f"  - Keep messages short — one to three sentences is typical for chat.\n"
            f"\n"
            f"Live heartbeat: turn {turn_number}. You have roughly {remaining_patience} turns of patience left "
            f"before you would normally walk away from a real assistant.\n"
            f"\n"
            f"Latest world snapshot:\n{world_snapshot}\n"
            f"\n"
            f"Reply with ONLY the next message you would send. No narration, no labels."
        )

    @staticmethod
    def _render_history_for_user(history: list[MessageTurn]) -> list[dict[str, str]]:
        """Flip role perspective so the simulated-user LLM sees its own past lines as 'assistant'.

        From the simulated user's POV, the executor under test is the "user"
        of the chat (it's the other party), and the simulated user's previous
        outputs are its own "assistant" turns. ``tool`` turns are flattened to
        plain assistant text so the model sees the executor's actions as
        already-narrated context.
        """
        flipped: list[dict[str, str]] = []
        for turn in history[-20:]:
            if turn.role == "system":
                continue
            if turn.role == "user":
                # The simulated user spoke this — its own "assistant" line.
                flipped.append({"role": "assistant", "content": turn.content})
            elif turn.role == "assistant":
                # The executor (other party) spoke this.
                flipped.append({"role": "user", "content": turn.content})
            elif turn.role == "tool":
                tool_name = turn.name or "tool"
                flipped.append(
                    {
                        "role": "user",
                        "content": f"[executor tool result via {tool_name}] {turn.content}",
                    }
                )
        return flipped

    def _build_judge_prompt(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> str:
        judge_turn_number = sum(1 for turn in history if turn.role == "user") + 1
        world_snapshot = _summarize_world_state(world_state)
        transcript_lines: list[str] = []
        for turn in history:
            if turn.role == "system":
                continue
            speaker = {
                "user": f"{scenario.persona.name} (user)",
                "assistant": "Executor",
                "tool": f"Tool[{turn.name or '?'}]",
            }.get(turn.role, turn.role)
            transcript_lines.append(f"  {speaker}: {turn.content}")
        transcript = "\n".join(transcript_lines) if transcript_lines else "  (empty)"

        success_clause = ""
        if scenario.success_criteria:
            bullets = "\n".join(f"    - {item}" for item in scenario.success_criteria)
            success_clause = (
                "\nThe persona's goal is satisfied if the executor:\n" + bullets + "\n"
            )

        world_clause = ""
        if scenario.world_assertions:
            bullets = "\n".join(f"    - {item}" for item in scenario.world_assertions)
            world_clause = (
                "\nWorld-state assertions to consider as evidence (natural language; do not try to evaluate them mechanically):\n"
                + bullets
                + "\n"
            )

        return (
            "You are an impartial judge for the LifeOpsBench live-mode benchmark.\n"
            "\n"
            "PERSONA: " + scenario.persona.name + "\n"
            "PERSONA GOAL (the user actually wanted this — the executor was NOT given it verbatim):\n"
            "  " + scenario.instruction + "\n"
            f"Live heartbeat: turn {judge_turn_number}.\n"
            + success_clause
            + world_clause
            + "\nLATEST WORLD SNAPSHOT:\n"
            + world_snapshot
            + "\nCONVERSATION TRANSCRIPT:\n"
            + transcript
            + "\n\n"
            "Question: Did the executor MEANINGFULLY satisfy the persona's goal in spirit?\n"
            "\n"
            "Be conservative. Only answer YES if the goal is actually addressed:\n"
            "  - 'I'll do that' / 'I can help with that' WITHOUT execution is NOT satisfied.\n"
            "  - Asking clarifying questions is NOT satisfied (still in progress).\n"
            "  - Refusal or off-topic responses are NOT satisfied.\n"
            "  - Partial completion that the persona explicitly accepted IS satisfied.\n"
            "\n"
            "Respond with a single JSON object and nothing else:\n"
            '  {"satisfied": true, "reason": "<one-sentence reason>"}\n'
            '  {"satisfied": false, "reason": "<one-sentence reason>"}\n'
            "If you cannot produce JSON, fall back to:\n"
            "  YES: <one-sentence reason>\n"
            "  NO: <one-sentence reason>\n"
        )

    @staticmethod
    def _looks_like_clarifying_question(
        agent_message: str,
        fallback: FirstQuestionFallback,
    ) -> bool:
        text = (agent_message or "").strip()
        if not text:
            return False
        return "?" in text
