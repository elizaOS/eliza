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

from typing import TYPE_CHECKING

from .clients.base import BaseClient, ClientCall
from .types import FirstQuestionFallback, MessageTurn, Scenario

if TYPE_CHECKING:
    from .lifeworld import LifeWorld


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

        system_prompt = self._build_user_simulation_prompt(
            scenario, turn_number, remaining_patience
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
        verdict = (response.content or "").strip()
        first_line = verdict.splitlines()[0].strip().upper() if verdict else ""
        satisfied = first_line.startswith("YES")
        reason = verdict[3:].lstrip(" :-—") if first_line.startswith(("YES", "NO")) else verdict
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
            f"This is turn {turn_number}. You have roughly {remaining_patience} turns of patience left "
            f"before you would normally walk away from a real assistant.\n"
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
            + success_clause
            + world_clause
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
            "Respond with one of:\n"
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
