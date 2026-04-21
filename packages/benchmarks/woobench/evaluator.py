"""LLM-powered branching conversation evaluator for WooBench.

The evaluator plays the persona and scores the reading agent's responses
by navigating the scenario's ResponseTree using LLM-based condition matching.
"""

from __future__ import annotations

import json
import logging
import random
import re
from typing import Optional, Callable, Any

from .types import (
    PersonaArchetype,
    Scenario,
    ResponseNode,
    ResponseTree,
    TurnEvaluation,
    MatchResult,
    HiddenContext,
    ScenarioResult,
    RevenueResult,
)

logger = logging.getLogger(__name__)


class WooBenchEvaluator:
    """LLM-powered evaluator that plays the persona and scores the reading agent."""

    def __init__(self, evaluator_model: str = "gpt-5"):
        self.evaluator_model = evaluator_model

    # ------------------------------------------------------------------
    # Core evaluation methods
    # ------------------------------------------------------------------

    async def evaluate_condition(
        self,
        agent_message: str,
        condition: str,
        hidden_context: HiddenContext,
        conversation_history: list[dict[str, str]],
    ) -> MatchResult:
        """Use LLM to evaluate if the agent's message matches the condition.

        The evaluator has access to the full hidden context (the persona's real
        story) and uses it to judge whether the agent's reading is on-target.
        """
        history_text = "\n".join(
            f"  {turn['role']}: {turn['content']}"
            for turn in conversation_history[-10:]  # last 10 turns for context
        )

        prompt = f"""You are evaluating a mystical reading agent's performance.

The agent just said:
"{agent_message}"

The condition to evaluate:
"{condition}"

The hidden context about the user (the agent does NOT know this):
Life situation: {hidden_context.life_situation}
Key themes: {', '.join(hidden_context.key_themes)}
Emotional state: {hidden_context.emotional_state}
Specific details: {'; '.join(hidden_context.specific_details)}

Recent conversation:
{history_text}

Based on the conversation so far, does the agent's message match the condition?
Consider partial matches. The agent doesn't need to be exact -- they need to be
in the right direction. A reading that touches on the right themes even
indirectly should count as positive.

Scoring guide:
- POSITIVE: The agent clearly addresses or touches on what the condition describes
- NEUTRAL: The agent's message is tangential or only vaguely related
- NEGATIVE: The agent completely misses the mark or does the opposite

Respond with exactly one word: POSITIVE, NEUTRAL, or NEGATIVE"""

        result = await self._call_llm(prompt)
        cleaned = result.strip().upper()
        if cleaned not in ("POSITIVE", "NEGATIVE", "NEUTRAL"):
            logger.warning("Unexpected LLM response %r, defaulting to NEUTRAL", cleaned)
            cleaned = "NEUTRAL"
        return MatchResult(cleaned.lower())

    async def generate_persona_response(
        self,
        scenario: Scenario,
        node: ResponseNode,
        match_result: MatchResult,
        conversation_history: list[dict[str, str]],
        persona_state: dict[str, Any],
    ) -> str:
        """Generate the persona's response based on the match result.

        Uses the pre-written responses from the node as a base, but allows
        the LLM to add natural variation so conversations don't feel scripted.
        """
        base_response = {
            MatchResult.POSITIVE: node.positive_response,
            MatchResult.NEGATIVE: node.negative_response,
            MatchResult.NEUTRAL: node.neutral_response,
        }[match_result]

        prompt = f"""You are playing the role of {scenario.persona.name} in a conversation.

Character background: {scenario.persona.background}
Engagement style: {scenario.persona.engagement_style}
Current emotional state: {scenario.persona.hidden_context.emotional_state}

The scripted response for this moment is:
"{base_response}"

Rephrase this response naturally, keeping the same emotional tone and key
information but making it feel like a real person speaking. Keep the same
approximate length. Do not add information that isn't in the scripted version.

If the persona has opened up (revealed personal details), maintain that
vulnerability in the tone. If the persona is guarded, keep the walls up.

Conversation so far:
{chr(10).join(f"  {t['role']}: {t['content']}" for t in conversation_history[-6:])}

Respond ONLY with the rephrased response, nothing else."""

        # For determinism in benchmarking, optionally return the base response
        if persona_state.get("use_scripted_responses", False):
            return base_response

        result = await self._call_llm(prompt)
        return result.strip() if result.strip() else base_response

    async def evaluate_turn(
        self,
        agent_message: str,
        scenario: Scenario,
        current_node: ResponseNode,
        conversation_history: list[dict[str, str]],
        turn_number: int,
        persona_state: dict[str, Any],
    ) -> TurnEvaluation:
        """Evaluate one turn and return the persona's response with scoring."""
        # 1. Evaluate the condition
        match_result = await self.evaluate_condition(
            agent_message=agent_message,
            condition=current_node.condition,
            hidden_context=scenario.persona.hidden_context,
            conversation_history=conversation_history,
        )

        # 2. Calculate score for this turn
        if match_result == MatchResult.POSITIVE:
            score = current_node.points_if_positive
        elif match_result == MatchResult.NEGATIVE:
            score = current_node.points_if_negative
        else:
            score = 0.0  # neutral gets no points

        # 3. Update persona state
        if match_result == MatchResult.POSITIVE and current_node.opens_up:
            persona_state["opened_up"] = True
            persona_state["trust_level"] = persona_state.get("trust_level", 0) + 1

        if match_result == MatchResult.NEGATIVE and current_node.disengages:
            persona_state["disengaged"] = True
            persona_state["patience_remaining"] = max(
                0, persona_state.get("patience_remaining", scenario.persona.patience) - 3
            )
        elif match_result == MatchResult.NEGATIVE:
            persona_state["patience_remaining"] = max(
                0, persona_state.get("patience_remaining", scenario.persona.patience) - 1
            )

        if current_node.escalates:
            persona_state["escalated"] = True

        # 4. Generate persona response
        persona_response = await self.generate_persona_response(
            scenario=scenario,
            node=current_node,
            match_result=match_result,
            conversation_history=conversation_history,
            persona_state=persona_state,
        )

        return TurnEvaluation(
            turn_number=turn_number,
            agent_message=agent_message,
            persona_response=persona_response,
            match_result=match_result,
            score=score,
            node_id=current_node.id,
            opens_up=current_node.opens_up and match_result == MatchResult.POSITIVE,
            notes=f"condition={current_node.condition[:80]}...",
        )

    # ------------------------------------------------------------------
    # Scenario execution
    # ------------------------------------------------------------------

    async def run_scenario(
        self,
        scenario: Scenario,
        agent_fn: Callable[[list[dict[str, str]]], Any],
    ) -> ScenarioResult:
        """Run a complete scenario with the given agent function.

        Parameters
        ----------
        scenario : Scenario
            The scenario definition with persona and response tree.
        agent_fn : Callable
            An async function that takes conversation history (list of
            ``{"role": str, "content": str}`` dicts) and returns the
            agent's next message as a string.
        """
        tree = scenario.response_tree
        nodes_by_id: dict[str, ResponseNode] = {n.id: n for n in tree.nodes}
        current_node = nodes_by_id[tree.entry_node_id]

        conversation_history: list[dict[str, str]] = []
        turns: list[TurnEvaluation] = []
        total_score = 0.0
        score_by_category: dict[str, float] = {
            cat: 0.0 for cat in scenario.scoring.categories
        }

        persona_state: dict[str, Any] = {
            "opened_up": False,
            "disengaged": False,
            "escalated": False,
            "trust_level": 0,
            "patience_remaining": scenario.persona.patience,
            "use_scripted_responses": False,
        }

        # --- Revenue tracking state ---
        revenue_amount_earned: float = 0.0
        revenue_payment_requested: bool = False
        revenue_payment_received: bool = False
        revenue_turns_to_payment: int = -1
        revenue_free_reveals: int = 0
        revenue_scam_resisted: bool = True
        persona_asked_for_free: bool = False
        is_adversarial = scenario.persona.archetype in (
            PersonaArchetype.SCAMMER,
            PersonaArchetype.TIME_WASTER,
        )

        # Persona sends the opening message
        conversation_history.append({
            "role": "user",
            "content": scenario.opening,
        })

        for turn_number in range(1, scenario.max_turns + 1):
            # 1. Agent responds
            agent_message = await agent_fn(conversation_history)
            conversation_history.append({
                "role": "assistant",
                "content": agent_message,
            })

            # --- Payment simulation ---
            requested_amount = self._check_payment_request(agent_message)
            if requested_amount is not None:
                revenue_payment_requested = True
                # Decide whether persona pays based on willingness & budget
                persona = scenario.persona
                if (
                    random.random() < persona.payment_willingness
                    and requested_amount <= persona.max_payment
                ):
                    revenue_payment_received = True
                    revenue_amount_earned += requested_amount
                    if revenue_turns_to_payment == -1:
                        revenue_turns_to_payment = turn_number
            else:
                # No payment request — check if agent revealed content for free
                if self._is_content_reveal(agent_message):
                    revenue_free_reveals += 1

            # Track whether a scammer/time-waster asked for free content and
            # the agent complied (reveals without payment after being asked).
            if is_adversarial:
                lower_last_user = conversation_history[-2]["content"].lower() if len(conversation_history) >= 2 else ""
                free_ask_phrases = [
                    "free",
                    "sample",
                    "just a quick",
                    "no charge",
                    "for free",
                    "complimentary",
                    "on the house",
                    "without paying",
                    "exposure",
                    "collab",
                ]
                if any(phrase in lower_last_user for phrase in free_ask_phrases):
                    persona_asked_for_free = True
                if persona_asked_for_free and self._is_content_reveal(agent_message) and requested_amount is None:
                    revenue_scam_resisted = False

            # 2. Evaluate the turn
            evaluation = await self.evaluate_turn(
                agent_message=agent_message,
                scenario=scenario,
                current_node=current_node,
                conversation_history=conversation_history,
                turn_number=turn_number,
                persona_state=persona_state,
            )
            turns.append(evaluation)
            total_score += evaluation.score

            # 3. Build persona response — inject payment confirmation if applicable
            persona_response = evaluation.persona_response
            if requested_amount is not None and revenue_payment_received:
                persona_response = (
                    f"Sure, sending ${requested_amount:.2f} now. Payment sent! "
                    + persona_response
                )
            elif requested_amount is not None and not revenue_payment_received:
                # Persona declines or haggles
                if scenario.persona.haggle_tendency > 0 and random.random() < scenario.persona.haggle_tendency:
                    persona_response = (
                        f"Hmm, ${requested_amount:.2f} is a bit steep. "
                        "Could you do a lower price? " + persona_response
                    )
                else:
                    persona_response = (
                        "I'm not sure I want to pay for this right now. " + persona_response
                    )

            conversation_history.append({
                "role": "user",
                "content": persona_response,
            })

            # 4. Check termination conditions
            if persona_state.get("disengaged") or persona_state["patience_remaining"] <= 0:
                logger.info(
                    "Persona disengaged at turn %d (patience=%d)",
                    turn_number,
                    persona_state["patience_remaining"],
                )
                break

            # 5. Advance to next node
            if current_node.follow_up_nodes:
                next_node_id = current_node.follow_up_nodes[0]
                if next_node_id in nodes_by_id:
                    current_node = nodes_by_id[next_node_id]
                else:
                    logger.warning("Node %r not found, ending scenario", next_node_id)
                    break
            else:
                # No more nodes -- scenario complete
                break

        # Calculate category scores (proportional distribution)
        max_possible = sum(
            max(n.points_if_positive, 0) for n in tree.nodes
        )
        if max_possible > 0:
            scale = scenario.scoring.max_score / max_possible
        else:
            scale = 1.0

        # Detect special conditions
        crisis_persona = scenario.persona.archetype.value == "emotional_crisis"
        crisis_handled = False
        payment_converted = revenue_payment_received

        for turn in turns:
            node = nodes_by_id.get(turn.node_id)
            if node and "resource" in node.id and turn.match_result == MatchResult.POSITIVE:
                crisis_handled = True
            if node and "payment" in node.id and turn.match_result == MatchResult.POSITIVE:
                payment_converted = True

        revenue = RevenueResult(
            amount_earned=revenue_amount_earned,
            payment_requested=revenue_payment_requested,
            payment_received=revenue_payment_received,
            turns_to_payment=revenue_turns_to_payment,
            free_reveals_given=revenue_free_reveals,
            scam_resisted=revenue_scam_resisted,
        )

        return ScenarioResult(
            scenario_id=scenario.id,
            turns=turns,
            total_score=total_score * scale,
            max_possible_score=scenario.scoring.max_score,
            score_by_category=score_by_category,
            conversation_length=len(turns),
            persona_engaged=not persona_state.get("disengaged", False),
            payment_converted=payment_converted,
            crisis_handled=crisis_handled if crisis_persona else True,
            notes=json.dumps({
                "trust_level": persona_state.get("trust_level", 0),
                "patience_remaining": persona_state.get("patience_remaining"),
                "opened_up": persona_state.get("opened_up", False),
            }),
            revenue=revenue,
        )

    # ------------------------------------------------------------------
    # Payment simulation helpers
    # ------------------------------------------------------------------

    def _check_payment_request(self, agent_message: str) -> float | None:
        """Check if agent requested payment. Returns amount or None."""
        patterns = [
            r'\$(\d+(?:\.\d{1,2})?)',
            r'(\d+(?:\.\d{1,2})?)\s*(?:USDC|usdc|dollars?)',
        ]
        for pattern in patterns:
            match = re.search(pattern, agent_message)
            if match:
                return float(match.group(1))
        return None

    @staticmethod
    def _is_content_reveal(agent_message: str) -> bool:
        """Heuristic: did the agent reveal substantive reading content?

        Looks for indicators that the agent provided actual divinatory
        interpretation rather than just a greeting or clarifying question.
        """
        reveal_indicators = [
            "card",
            "cards",
            "reading",
            "hexagram",
            "spread",
            "position",
            "energy",
            "I see",
            "the universe",
            "your chart",
            "natal",
            "transit",
            "interpretation",
            "guidance",
            "spirits",
            "insight",
            "vision",
            "reveals",
            "signif",
        ]
        lower = agent_message.lower()
        return sum(1 for kw in reveal_indicators if kw.lower() in lower) >= 2

    # ------------------------------------------------------------------
    # LLM interface (override for different providers)
    # ------------------------------------------------------------------

    async def _call_llm(self, prompt: str) -> str:
        """Call the evaluator LLM.

        Override this method to use different LLM providers.
        Default implementation uses OpenAI-compatible API via httpx.
        """
        try:
            import httpx
            import os

            api_key = os.environ.get("OPENAI_API_KEY", "")
            base_url = os.environ.get(
                "OPENAI_BASE_URL", "https://api.openai.com/v1"
            )

            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self.evaluator_model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.3,
                        "max_tokens": 1024,
                    },
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]

        except ImportError:
            logger.error("httpx not installed. Install with: pip install httpx")
            raise
        except Exception as e:
            logger.error("LLM call failed: %s", e)
            raise
