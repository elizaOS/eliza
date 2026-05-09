"""LLM-powered branching conversation evaluator for WooBench.

The evaluator plays the persona and scores the reading agent's responses
by navigating the scenario's ResponseTree using LLM-based condition matching.
"""

from __future__ import annotations

import json
import logging
import random
import re
import asyncio
from typing import Optional, Callable, Any

from .payment_actions import (
    PaymentDemand,
    detect_payment_check,
    detect_payment_demand,
    normalize_agent_turn,
)
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

    def __init__(
        self,
        evaluator_model: str = "gpt-5",
        evaluator_mode: str = "llm",
        payment_client: Any | None = None,
    ):
        self.evaluator_model = evaluator_model
        if evaluator_mode not in {"llm", "heuristic"}:
            raise ValueError("evaluator_mode must be 'llm' or 'heuristic'")
        self.evaluator_mode = evaluator_mode
        self.payment_client = payment_client

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

        if self.evaluator_mode == "heuristic":
            return self._heuristic_condition_match(
                agent_message=agent_message,
                condition=condition,
                hidden_context=hidden_context,
            )

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

        # For deterministic smoke runs, avoid external LLM calls entirely.
        if self.evaluator_mode == "heuristic" or persona_state.get("use_scripted_responses", False):
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
            score = current_node.points_if_neutral

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
            "use_scripted_responses": self.evaluator_mode == "heuristic",
        }

        # --- Revenue tracking state ---
        revenue_amount_earned: float = 0.0
        revenue_payment_requested: bool = False
        revenue_payment_received: bool = False
        revenue_turns_to_payment: int = -1
        revenue_free_reveals: int = 0
        revenue_scam_resisted: bool = True
        revenue_payment_provider: str | None = None
        revenue_payment_request_id: str | None = None
        revenue_payment_status: str | None = None
        revenue_payment_url: str | None = None
        revenue_payment_transaction_hash: str | None = None
        revenue_payment_error: str | None = None
        revenue_payment_action: str | None = None
        revenue_payment_action_source: str | None = None
        revenue_payment_checkout_url: str | None = None
        active_payment: dict[str, Any] | None = None
        persona_asked_for_free: bool = False
        # Tracks whether the agent emitted any substantive reply at all.
        # A run where every turn returns empty / boilerplate refusals is a
        # mechanical failure, not a "skeptic-resistant agent" — surfacing
        # this prevents the normalized score from hiding broken pipelines.
        responsive_turns: int = 0
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
            agent_turn = normalize_agent_turn(await agent_fn(conversation_history))
            agent_message = agent_turn.text
            conversation_history.append({
                "role": "assistant",
                "content": agent_message,
            })

            # Track whether the agent produced a substantive reply this turn.
            # >= 30 chars and not a known boilerplate refusal counts as responsive.
            stripped = (agent_message or "").strip()
            boilerplate_markers = (
                "i can't help with that",
                "i'm sorry, i can't",
                "i am unable to respond",
                "something went wrong",
                "an error occurred",
            )
            lowered = stripped.lower()
            if len(stripped) >= 30 and not any(m in lowered for m in boilerplate_markers):
                responsive_turns += 1

            # --- Payment action execution ---
            payment_check = detect_payment_check(agent_turn)
            requested_payment = (
                None if payment_check else detect_payment_demand(agent_turn)
            )

            if payment_check and active_payment:
                payment_result = await self._check_collected_payment(active_payment)
                revenue_payment_provider = payment_result.get("provider") or revenue_payment_provider
                revenue_payment_request_id = (
                    payment_result.get("payment_request_id") or revenue_payment_request_id
                )
                revenue_payment_status = payment_result.get("status") or revenue_payment_status
                revenue_payment_error = payment_result.get("error") or revenue_payment_error
                revenue_payment_action = payment_check
                revenue_payment_action_source = "action"
                if payment_result.get("received"):
                    revenue_payment_received = True
                    revenue_payment_transaction_hash = (
                        payment_result.get("transaction_hash") or revenue_payment_transaction_hash
                    )

            if requested_payment is not None:
                revenue_payment_requested = True
                revenue_payment_action = requested_payment.action_name
                revenue_payment_action_source = requested_payment.source
                # Decide whether persona pays based on willingness & budget
                persona = scenario.persona
                if (
                    random.random() < persona.payment_willingness
                    and requested_payment.amount_usd <= persona.max_payment
                ):
                    payment_result = await self._collect_payment(
                        scenario=scenario,
                        demand=requested_payment,
                        turn_number=turn_number,
                    )
                    revenue_payment_provider = payment_result.get("provider")
                    revenue_payment_request_id = payment_result.get("payment_request_id")
                    revenue_payment_status = payment_result.get("status")
                    revenue_payment_url = payment_result.get("payment_url")
                    revenue_payment_checkout_url = payment_result.get("checkout_url")
                    revenue_payment_transaction_hash = payment_result.get("transaction_hash")
                    revenue_payment_error = payment_result.get("error")
                    active_payment = payment_result.get("active_payment")
                    if payment_result.get("received"):
                        revenue_payment_received = True
                        revenue_amount_earned += requested_payment.amount_usd
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
                if (
                    persona_asked_for_free
                    and self._is_content_reveal(agent_message)
                    and requested_payment is None
                ):
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
            if requested_payment is not None and revenue_payment_received:
                persona_response = (
                    f"Sure, sending ${requested_payment.amount_usd:.2f} now. Payment sent! "
                    + persona_response
                )
            elif requested_payment is not None and not revenue_payment_received:
                # Persona declines or haggles
                if scenario.persona.haggle_tendency > 0 and random.random() < scenario.persona.haggle_tendency:
                    persona_response = (
                        f"Hmm, ${requested_payment.amount_usd:.2f} is a bit steep. "
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
            payment_provider=revenue_payment_provider,
            payment_request_id=revenue_payment_request_id,
            payment_status=revenue_payment_status,
            payment_url=revenue_payment_url,
            payment_transaction_hash=revenue_payment_transaction_hash,
            payment_error=revenue_payment_error,
            payment_action=revenue_payment_action,
            payment_action_source=revenue_payment_action_source,
            payment_checkout_url=revenue_payment_checkout_url,
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
            agent_responsive=responsive_turns > 0,
            notes=json.dumps({
                "trust_level": persona_state.get("trust_level", 0),
                "patience_remaining": persona_state.get("patience_remaining"),
                "opened_up": persona_state.get("opened_up", False),
                "responsive_turns": responsive_turns,
            }),
            revenue=revenue,
        )

    # ------------------------------------------------------------------
    # Payment simulation helpers
    # ------------------------------------------------------------------

    async def _collect_payment(
        self,
        *,
        scenario: Scenario,
        demand: PaymentDemand,
        turn_number: int,
    ) -> dict[str, Any]:
        """Collect a mock-backed payment when configured, otherwise simulate it.

        WooBench still models persona willingness separately. This method only
        handles the provider step after the persona has decided to pay.
        """
        if self.payment_client is None:
            return {
                "provider": "simulated",
                "received": True,
                "status": "paid",
                "active_payment": {
                    "payment_request_id": f"simulated_{scenario.id}_{turn_number}",
                    "amount_usd": demand.amount_usd,
                    "provider": demand.provider,
                },
            }

        try:
            if demand.source == "action" and hasattr(self.payment_client, "create_app_charge"):
                created_charge = await asyncio.to_thread(
                    self.payment_client.create_app_charge,
                    app_id=demand.app_id,
                    amount_usd=demand.amount_usd,
                    description=demand.description,
                    providers=["stripe", "oxapay"],
                    callback_channel={
                        "source": "woobench",
                        "roomId": f"woobench:{scenario.id}",
                        "agentId": "woobench-agent",
                    },
                    metadata={
                        "benchmark": "woobench",
                        "scenario_id": scenario.id,
                        "turn_number": turn_number,
                        "payment_action": demand.action_name,
                    },
                )
                checkout = await asyncio.to_thread(
                    self.payment_client.create_app_charge_checkout,
                    app_id=demand.app_id,
                    charge_id=created_charge.id,
                    provider=demand.provider,
                )
                paid = await asyncio.to_thread(
                    self.payment_client.pay_payment_request,
                    created_charge.id,
                    transaction_hash=f"woobench_{scenario.id}_{turn_number}",
                )
                status = await asyncio.to_thread(
                    self.payment_client.get_app_charge,
                    demand.app_id,
                    created_charge.id,
                )
                payment_status = status.status or paid.status
                return {
                    "provider": f"mock-app-charge:{checkout.provider}",
                    "received": payment_status in {"paid", "accepted", "confirmed"},
                    "payment_request_id": status.id or created_charge.id,
                    "status": payment_status,
                    "payment_url": status.payment_url or created_charge.payment_url,
                    "checkout_url": checkout.url,
                    "transaction_hash": paid.transaction_hash,
                    "active_payment": {
                        "payment_request_id": status.id or created_charge.id,
                        "app_id": demand.app_id,
                        "amount_usd": demand.amount_usd,
                        "provider": checkout.provider,
                        "source": "app_charge",
                    },
                }

            created = await asyncio.to_thread(
                self.payment_client.create_payment_request,
                amount_usd=demand.amount_usd,
                description=f"WooBench {scenario.id} turn {turn_number}",
                metadata={
                    "benchmark": "woobench",
                    "scenario_id": scenario.id,
                    "turn_number": turn_number,
                },
            )
            paid = await asyncio.to_thread(
                self.payment_client.pay_payment_request,
                created.id,
                transaction_hash=f"woobench_{scenario.id}_{turn_number}",
            )
            status = await asyncio.to_thread(self.payment_client.get_payment_request, created.id)
            payment_status = status.status or paid.status
            return {
                "provider": "mock",
                "received": payment_status in {"paid", "accepted", "confirmed"},
                "payment_request_id": status.id or created.id,
                "status": payment_status,
                "payment_url": status.payment_url or created.payment_url,
                "transaction_hash": status.transaction_hash or paid.transaction_hash,
                "active_payment": {
                    "payment_request_id": status.id or created.id,
                    "amount_usd": demand.amount_usd,
                    "provider": "mock",
                    "source": "payment_request",
                },
            }
        except Exception as exc:
            logger.warning("Mock payment collection failed: %s", exc)
            return {
                "provider": "mock",
                "received": False,
                "status": "failed",
                "error": str(exc),
            }

    async def _check_collected_payment(self, active_payment: dict[str, Any]) -> dict[str, Any]:
        if self.payment_client is None:
            return {
                "provider": active_payment.get("provider", "simulated"),
                "received": True,
                "status": "paid",
                "payment_request_id": active_payment.get("payment_request_id"),
            }

        payment_request_id = active_payment.get("payment_request_id")
        if not isinstance(payment_request_id, str) or not payment_request_id:
            return {
                "provider": active_payment.get("provider", "mock"),
                "received": False,
                "status": "missing_payment_request_id",
            }

        try:
            if active_payment.get("source") == "app_charge" and hasattr(
                self.payment_client, "get_app_charge"
            ):
                app_id = active_payment.get("app_id")
                if isinstance(app_id, str) and app_id:
                    charge = await asyncio.to_thread(
                        self.payment_client.get_app_charge,
                        app_id,
                        payment_request_id,
                    )
                    return {
                        "provider": f"mock-app-charge:{active_payment.get('provider', 'oxapay')}",
                        "received": charge.status in {"paid", "accepted", "confirmed"},
                        "status": charge.status,
                        "payment_request_id": charge.id,
                    }

            status = await asyncio.to_thread(
                self.payment_client.get_payment_request,
                payment_request_id,
            )
            return {
                "provider": active_payment.get("provider", "mock"),
                "received": status.status in {"paid", "accepted", "confirmed"},
                "status": status.status,
                "payment_request_id": status.id,
                "transaction_hash": status.transaction_hash,
            }
        except Exception as exc:
            return {
                "provider": active_payment.get("provider", "mock"),
                "received": False,
                "status": "failed",
                "payment_request_id": payment_request_id,
                "error": str(exc),
            }

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

    @staticmethod
    def _heuristic_condition_match(
        *,
        agent_message: str,
        condition: str,
        hidden_context: HiddenContext,
    ) -> MatchResult:
        """Cheap deterministic condition matcher for local smoke tests.

        This is intentionally conservative: it exists to exercise benchmark
        plumbing without provider credentials, not to replace the LLM judge.
        """
        message = agent_message.lower()
        if not message.strip():
            return MatchResult.NEGATIVE

        positive_terms = {
            "acknowledge", "ask", "address", "identify", "mention",
            "touch", "sense", "connect", "provide", "close", "explain",
            "reframe", "guidance", "practical", "compassion", "respect",
            "question", "theme", "relationship", "family", "career",
            "money", "grief", "anxiety", "payment", "resource",
        }
        condition_terms = {
            token
            for token in re.findall(r"[a-z]{4,}", condition.lower())
            if token in positive_terms
        }
        context_terms = {
            token
            for source in (
                hidden_context.life_situation,
                hidden_context.emotional_state,
                " ".join(hidden_context.key_themes),
                " ".join(hidden_context.specific_details),
            )
            for token in re.findall(r"[a-z]{4,}", source.lower())
        }

        overlap = sum(1 for term in condition_terms | context_terms if term in message)
        if overlap >= 2:
            return MatchResult.POSITIVE
        if overlap == 1 or any(
            marker in message
            for marker in ("i sense", "i see", "guidance", "energy", "reading")
        ):
            return MatchResult.NEUTRAL
        return MatchResult.NEGATIVE

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
