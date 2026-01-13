"""
ElizaOS agent for Diplomacy environment.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_diplomacy.types import (
    Power,
    Phase,
    Order,
    OrderType,
    GameState,
    Message,
)
from elizaos_atropos_diplomacy.map_data import get_adjacent_provinces

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.primitives import UUID


class DiplomacyAgent:
    """
    ElizaOS-powered Diplomacy agent.
    
    Represents one of the seven great powers and can:
    - Analyze the board position
    - Make strategic decisions
    - Negotiate with other powers (in press mode)
    
    Example:
        >>> runtime = AgentRuntime(plugins=[get_openai_plugin()])
        >>> await runtime.initialize()
        >>> agent = DiplomacyAgent(runtime, Power.FRANCE)
        >>> orders = await agent.decide_orders(game_state)
    """

    def __init__(
        self,
        runtime: AgentRuntime | None = None,
        power: Power = Power.FRANCE,
        use_llm: bool = True,
        agent_id: UUID | None = None,
    ) -> None:
        """
        Initialize the Diplomacy agent.
        
        Args:
            runtime: ElizaOS AgentRuntime
            power: The power this agent plays as
            use_llm: Whether to use LLM for decisions
            agent_id: Optional agent ID
        """
        self._runtime = runtime
        self._power = power
        self._use_llm = use_llm
        self._agent_id = agent_id or str(uuid.uuid4())
        self._message_history: list[Message] = []

    @property
    def power(self) -> Power:
        """Get the power this agent represents."""
        return self._power

    @property
    def agent_id(self) -> str:
        """Get agent ID."""
        return str(self._agent_id)

    async def decide_orders(
        self,
        state: GameState,
        available_orders: list[Order] | None = None,
        *,
        trajectory_step_id: str | None = None,
    ) -> list[Order]:
        """
        Decide orders for the current phase.
        
        Args:
            state: Current game state
            available_orders: Optional pre-computed available orders
            
        Returns:
            List of orders for this power's units
        """
        if self._use_llm and self._runtime is not None:
            return await self._decide_with_eliza(state, trajectory_step_id=trajectory_step_id)
        return self._decide_with_heuristics(state)

    def _decide_with_heuristics(self, state: GameState) -> list[Order]:
        """Use simple heuristics for decision making."""
        orders: list[Order] = []
        power_state = state.powers[self._power]

        if state.phase == Phase.MOVEMENT:
            for unit in power_state.units:
                # Simple strategy: try to move toward unowned supply centers
                adjacent = get_adjacent_provinces(unit.location, unit.type)

                # Find adjacent supply centers not owned by us
                from elizaos_atropos_diplomacy.map_data import is_supply_center

                best_target = None
                for adj in adjacent:
                    if is_supply_center(adj) and adj not in power_state.supply_centers:
                        # Check if empty
                        if state.get_unit_at(adj) is None:
                            best_target = adj
                            break

                if best_target:
                    orders.append(Order(
                        unit=unit,
                        order_type=OrderType.MOVE,
                        target=best_target,
                    ))
                else:
                    # Hold if no good move
                    orders.append(Order(
                        unit=unit,
                        order_type=OrderType.HOLD,
                    ))

        elif state.phase == Phase.ADJUSTMENT:
            adjustment = power_state.adjustment_needed

            if adjustment > 0:
                # Build in home centers
                from elizaos_atropos_diplomacy.types import UnitType, Unit
                built = 0
                for center in power_state.home_centers:
                    if built >= adjustment:
                        break
                    if power_state.get_units_in_province(center) is None:
                        if center in power_state.supply_centers:
                            orders.append(Order(
                                unit=Unit(UnitType.ARMY, center, self._power),
                                order_type=OrderType.BUILD,
                                target=center,
                            ))
                            built += 1

            elif adjustment < 0:
                # Disband furthest from home
                units_to_disband = abs(adjustment)
                for unit in power_state.units[:units_to_disband]:
                    orders.append(Order(
                        unit=unit,
                        order_type=OrderType.DISBAND,
                    ))

        return orders

    async def _decide_with_eliza(self, state: GameState, *, trajectory_step_id: str | None = None) -> list[Order]:
        """Use canonical ElizaOS message pipeline for decision making."""
        if self._runtime is None:
            return self._decide_with_heuristics(state)

        try:
            from elizaos_atropos_shared.canonical_eliza import run_with_context
            from elizaos_atropos_diplomacy.eliza_plugin import (
                DIPLOMACY_STORE,
                DiplomacyDecisionContext,
            )

            _result, ctx = await run_with_context(
                self._runtime,
                DIPLOMACY_STORE,
                DiplomacyDecisionContext(state=state, power=self._power),
                source="atropos_diplomacy",
                text="Choose orders for the current phase.",
                trajectory_step_id=trajectory_step_id,
            )
            orders_text = ctx.orders_text

            if orders_text:
                return self._parse_orders_from_response(orders_text, state)
            return self._decide_with_heuristics(state)

        except Exception:
            return self._decide_with_heuristics(state)

    def _parse_orders_from_response(
        self,
        response: str,
        state: GameState,
    ) -> list[Order]:
        """Parse orders from LLM response."""
        # Simplified parsing - fall back to heuristics on parse failure
        orders: list[Order] = []
        power_state = state.powers[self._power]

        for line in response.split("\n"):
            line = line.strip().upper()
            if not line or line.startswith("#"):
                continue

            # Try to match unit and action
            for unit in power_state.units:
                unit_str = str(unit).upper()
                if unit_str in line or f"{unit.type.value} {unit.location}" in line:
                    if "HOLD" in line:
                        orders.append(Order(unit=unit, order_type=OrderType.HOLD))
                        break
                    elif "->" in line or "MOVE" in line:
                        # Extract target
                        parts = line.replace("->", " ").split()
                        for part in parts:
                            if len(part) == 3 and part.isalpha():
                                adjacent = get_adjacent_provinces(unit.location, unit.type)
                                if part in adjacent:
                                    orders.append(Order(
                                        unit=unit,
                                        order_type=OrderType.MOVE,
                                        target=part,
                                    ))
                                    break
                        break

        # Fill in missing orders with HOLD
        units_with_orders = {o.unit.location for o in orders}
        for unit in power_state.units:
            if unit.location not in units_with_orders:
                orders.append(Order(unit=unit, order_type=OrderType.HOLD))

        return orders

    async def negotiate(
        self,
        state: GameState,
        incoming_messages: list[Message],
    ) -> list[Message]:
        """
        Generate diplomatic messages to other powers.
        
        Args:
            state: Current game state
            incoming_messages: Messages received from other powers
            
        Returns:
            List of outgoing messages
        """
        if not self._use_llm or self._runtime is None:
            return []

        # Store incoming messages
        self._message_history.extend(incoming_messages)

        # Generate responses using LLM
        recent_messages = "\n".join(
            str(m) for m in incoming_messages[-5:]
        ) if incoming_messages else "No recent messages."

        prompt = f"""You are the ambassador of {self._power.full_name} in Diplomacy.

Recent diplomatic communications:
{recent_messages}

Current game state: {state.phase_name}
Your supply centers: {state.powers[self._power].center_count}

Compose diplomatic messages to other powers. Consider:
- Proposing alliances
- Coordinating attacks
- Gathering intelligence
- Misdirection (if strategic)

Format each message as:
TO [POWER]: [message]

Keep messages brief and strategic.
"""

        try:
            from elizaos import ChannelType, Content, Memory, string_to_uuid

            room_id = string_to_uuid(f"atropos:diplomacy:{state.phase_name}")
            entity_id = string_to_uuid(f"atropos:diplomacy:{self._power.value}")

            message = Memory(
                entity_id=entity_id,
                room_id=room_id,
                content=Content(
                    text=prompt,
                    source="atropos:diplomacy",
                    channel_type=ChannelType.DM.value,
                ),
            )

            result = await self._runtime.message_service.handle_message(self._runtime, message)

            response_text = (
                result.response_content.text
                if result.response_content and result.response_content.text
                else ""
            )

            return self._parse_messages_from_response(response_text, state.phase_name)

        except Exception:
            return []

    def _parse_messages_from_response(
        self,
        response: str,
        phase: str,
    ) -> list[Message]:
        """Parse messages from LLM response."""
        messages: list[Message] = []

        for line in response.split("\n"):
            line = line.strip()
            if line.startswith("TO "):
                try:
                    # Parse "TO FRANCE: message"
                    parts = line[3:].split(":", 1)
                    if len(parts) == 2:
                        recipient_str = parts[0].strip().upper()
                        content = parts[1].strip()

                        # Find matching power
                        for power in Power:
                            if power.value == recipient_str or power.name == recipient_str:
                                messages.append(Message(
                                    sender=self._power,
                                    recipient=power,
                                    content=content,
                                    phase=phase,
                                ))
                                break
                except Exception:
                    continue

        return messages
