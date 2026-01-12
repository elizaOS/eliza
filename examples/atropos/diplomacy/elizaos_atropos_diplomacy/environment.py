"""
Diplomacy environment implementation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos_atropos_diplomacy.types import (
    Power,
    Province,
    UnitType,
    OrderType,
    Phase,
    Season,
    Unit,
    Order,
    GameState,
    PowerState,
    Message,
    StepResult,
    EpisodeResult,
)
from elizaos_atropos_diplomacy.map_data import (
    SUPPLY_CENTERS,
    HOME_CENTERS,
    STARTING_UNITS,
    get_adjacent_provinces,
    is_supply_center,
)

if TYPE_CHECKING:
    pass


class DiplomacyEnvironment:
    """
    Diplomacy multi-agent environment.
    
    Implements the classic Diplomacy board game rules with support
    for both No-Press (no negotiation) and Press (with negotiation) modes.
    
    Example:
        >>> env = DiplomacyEnvironment()
        >>> await env.initialize()
        >>> state = env.get_state()
        >>> orders = {Power.FRANCE: [...], Power.GERMANY: [...]}
        >>> result = await env.step(orders)
    """

    def __init__(
        self,
        press_mode: bool = False,
        max_years: int = 20,
    ) -> None:
        """
        Initialize the Diplomacy environment.
        
        Args:
            press_mode: Enable negotiation between powers
            max_years: Maximum game length in years
        """
        self._press_mode = press_mode
        self._max_years = max_years
        self._state: GameState | None = None
        self._initialized = False
        self._center_history: list[dict[Power, int]] = []

    @property
    def press_mode(self) -> bool:
        """Whether negotiation is enabled."""
        return self._press_mode

    @property
    def powers(self) -> list[Power]:
        """List of all powers."""
        return list(Power)

    @property
    def year(self) -> int:
        """Current game year."""
        return self._state.year if self._state else 1901

    async def initialize(self) -> None:
        """Initialize the game to starting position."""
        self._state = self._create_initial_state()
        self._center_history = []
        self._initialized = True

    def _create_initial_state(self) -> GameState:
        """Create the initial game state."""
        powers: dict[Power, PowerState] = {}

        for power in Power:
            # Create starting units
            units = [
                Unit(type=unit_type, location=location, power=power)
                for unit_type, location in STARTING_UNITS[power]
            ]

            # Set initial supply centers
            supply_centers = list(SUPPLY_CENTERS[power])
            home_centers = list(HOME_CENTERS[power])

            powers[power] = PowerState(
                power=power,
                units=units,
                supply_centers=supply_centers,
                home_centers=home_centers,
            )

        return GameState(
            year=1901,
            season=Season.SPRING,
            phase=Phase.MOVEMENT,
            powers=powers,
        )

    def get_state(self) -> GameState:
        """Get current game state."""
        if self._state is None:
            raise RuntimeError("Environment not initialized")
        return self._state

    def get_state_for_power(self, power: Power) -> GameState:
        """
        Get game state from a power's perspective.
        
        In press mode, this would filter messages appropriately.
        """
        return self.get_state()

    def is_game_over(self) -> bool:
        """Check if game has ended."""
        if self._state is None:
            return False

        # Check for winner
        if self._state.is_game_over:
            return True

        # Check max years
        if self._state.year > self._max_years:
            return True

        # Check if all but one power eliminated
        active = self._state.active_powers
        return len(active) <= 1

    def get_available_orders(self, power: Power) -> list[Order]:
        """
        Get list of available orders for a power.
        
        Returns all legal orders the power can give.
        """
        if self._state is None:
            return []

        power_state = self._state.powers[power]
        orders: list[Order] = []

        if self._state.phase == Phase.MOVEMENT:
            for unit in power_state.units:
                # HOLD is always available
                orders.append(Order(unit=unit, order_type=OrderType.HOLD))

                # MOVE to adjacent provinces
                adjacent = get_adjacent_provinces(unit.location, unit.type)
                for target in adjacent:
                    orders.append(Order(
                        unit=unit,
                        order_type=OrderType.MOVE,
                        target=target,
                    ))

                # SUPPORT (simplified - support any adjacent unit)
                for other_unit in self._state.get_all_units():
                    if other_unit.location in adjacent:
                        orders.append(Order(
                            unit=unit,
                            order_type=OrderType.SUPPORT,
                            support_unit=other_unit,
                        ))

        elif self._state.phase == Phase.RETREAT:
            # Handle retreat orders
            for province, retreat_options in self._state.pending_retreats.items():
                unit = power_state.get_units_in_province(province)
                if unit:
                    for target in retreat_options:
                        orders.append(Order(
                            unit=unit,
                            order_type=OrderType.RETREAT,
                            target=target,
                        ))
                    # Can also disband
                    orders.append(Order(
                        unit=unit,
                        order_type=OrderType.DISBAND,
                    ))

        elif self._state.phase == Phase.ADJUSTMENT:
            adjustment = power_state.adjustment_needed

            if adjustment > 0:
                # Build orders
                for center in power_state.home_centers:
                    if power_state.get_units_in_province(center) is None:
                        if center in power_state.supply_centers:
                            # Can build army
                            orders.append(Order(
                                unit=Unit(UnitType.ARMY, center, power),
                                order_type=OrderType.BUILD,
                                target=center,
                            ))
                            # Can build fleet if coastal
                            from elizaos_atropos_diplomacy.map_data import get_province_type, ProvinceType
                            if get_province_type(center) == ProvinceType.COASTAL:
                                orders.append(Order(
                                    unit=Unit(UnitType.FLEET, center, power),
                                    order_type=OrderType.BUILD,
                                    target=center,
                                ))

            elif adjustment < 0:
                # Disband orders
                for unit in power_state.units:
                    orders.append(Order(
                        unit=unit,
                        order_type=OrderType.DISBAND,
                    ))

        return orders

    async def step(
        self,
        orders: dict[Power, list[Order]],
        messages: list[Message] | None = None,
    ) -> StepResult:
        """
        Execute one step of the game.
        
        Args:
            orders: Orders from each power
            messages: Diplomatic messages (if press mode)
            
        Returns:
            StepResult with new state and resolution details
        """
        if self._state is None:
            raise RuntimeError("Environment not initialized")

        # Store messages if provided
        if messages and self._press_mode:
            self._state.message_history.extend(messages)

        # Resolve orders based on phase
        if self._state.phase == Phase.MOVEMENT:
            result = self._resolve_movement(orders)
        elif self._state.phase == Phase.RETREAT:
            result = self._resolve_retreats(orders)
        else:  # ADJUSTMENT
            result = self._resolve_adjustments(orders)

        # Advance phase
        self._advance_phase()

        # Record history
        if self._state.season == Season.WINTER and self._state.phase == Phase.ADJUSTMENT:
            self._center_history.append(self._state.get_center_count())

        return result

    def _resolve_movement(
        self,
        orders: dict[Power, list[Order]],
    ) -> StepResult:
        """Resolve movement phase orders."""
        resolved: dict[Power, list[tuple[Order, bool]]] = {p: [] for p in Power}
        retreats_needed: dict[Power, list[Unit]] = {p: [] for p in Power}

        # Collect all orders
        all_orders: list[Order] = []
        for power_orders in orders.values():
            all_orders.extend(power_orders)

        # Simple resolution: moves succeed if no conflict
        # This is a simplified version - real Diplomacy has complex adjudication
        move_targets: dict[Province, list[Order]] = {}

        for order in all_orders:
            if order.order_type == OrderType.MOVE:
                target = order.target
                if target:
                    if target not in move_targets:
                        move_targets[target] = []
                    move_targets[target].append(order)

        # Resolve conflicts (simplified: first order wins for ties)
        for order in all_orders:
            power = order.unit.power
            success = True

            if order.order_type == OrderType.MOVE and order.target:
                conflicting = move_targets.get(order.target, [])
                if len(conflicting) > 1:
                    # Count support (simplified)
                    supports = [
                        o for o in all_orders
                        if o.order_type == OrderType.SUPPORT
                        and o.support_unit == order.unit
                        and o.support_target == order.target
                    ]
                    # If not strongest, fail
                    if conflicting[0] != order:
                        success = False
                        if len(supports) == 0:
                            retreats_needed[power].append(order.unit)

            resolved[power].append((order, success))

            # Update unit position on success
            if success and order.order_type == OrderType.MOVE and order.target:
                order.unit.location = order.target

        # Update supply center ownership after Fall
        if self._state and self._state.season == Season.FALL:
            self._update_supply_centers()

        summary = self._generate_summary(resolved)

        return StepResult(
            state=self._state,  # type: ignore
            orders_resolved=resolved,
            retreats_needed=retreats_needed,
            messages=self._state.message_history[-10:] if self._state else [],
            summary=summary,
        )

    def _resolve_retreats(
        self,
        orders: dict[Power, list[Order]],
    ) -> StepResult:
        """Resolve retreat phase orders."""
        resolved: dict[Power, list[tuple[Order, bool]]] = {p: [] for p in Power}

        for power, power_orders in orders.items():
            for order in power_orders:
                if order.order_type == OrderType.RETREAT:
                    # Execute retreat
                    order.unit.location = order.target  # type: ignore
                    resolved[power].append((order, True))
                elif order.order_type == OrderType.DISBAND:
                    # Remove unit
                    if self._state:
                        self._state.powers[power].units.remove(order.unit)
                    resolved[power].append((order, True))

        # Clear pending retreats
        if self._state:
            self._state.pending_retreats = {}

        return StepResult(
            state=self._state,  # type: ignore
            orders_resolved=resolved,
            retreats_needed={p: [] for p in Power},
            messages=[],
            summary="Retreats resolved",
        )

    def _resolve_adjustments(
        self,
        orders: dict[Power, list[Order]],
    ) -> StepResult:
        """Resolve adjustment phase orders."""
        resolved: dict[Power, list[tuple[Order, bool]]] = {p: [] for p in Power}

        for power, power_orders in orders.items():
            power_state = self._state.powers[power] if self._state else None
            if not power_state:
                continue

            for order in power_orders:
                if order.order_type == OrderType.BUILD:
                    # Add new unit
                    new_unit = Unit(
                        type=order.unit.type,
                        location=order.target or order.unit.location,
                        power=power,
                    )
                    power_state.units.append(new_unit)
                    resolved[power].append((order, True))
                elif order.order_type == OrderType.DISBAND:
                    # Remove unit
                    if order.unit in power_state.units:
                        power_state.units.remove(order.unit)
                    resolved[power].append((order, True))

        return StepResult(
            state=self._state,  # type: ignore
            orders_resolved=resolved,
            retreats_needed={p: [] for p in Power},
            messages=[],
            summary="Adjustments complete",
        )

    def _update_supply_centers(self) -> None:
        """Update supply center ownership based on unit positions."""
        if self._state is None:
            return

        for power, power_state in self._state.powers.items():
            for unit in power_state.units:
                if is_supply_center(unit.location):
                    # Take control if not already owned
                    if unit.location not in power_state.supply_centers:
                        power_state.supply_centers.append(unit.location)

                        # Remove from other powers
                        for other_power, other_state in self._state.powers.items():
                            if other_power != power:
                                if unit.location in other_state.supply_centers:
                                    other_state.supply_centers.remove(unit.location)

    def _advance_phase(self) -> None:
        """Advance to the next phase."""
        if self._state is None:
            return

        if self._state.phase == Phase.MOVEMENT:
            if self._state.pending_retreats:
                self._state.phase = Phase.RETREAT
            elif self._state.season == Season.FALL:
                self._state.phase = Phase.ADJUSTMENT
                self._state.season = Season.WINTER
            else:
                self._state.season = Season.FALL
        elif self._state.phase == Phase.RETREAT:
            if self._state.season == Season.SPRING:
                self._state.season = Season.FALL
                self._state.phase = Phase.MOVEMENT
            else:
                self._state.phase = Phase.ADJUSTMENT
                self._state.season = Season.WINTER
        else:  # ADJUSTMENT
            self._state.year += 1
            self._state.season = Season.SPRING
            self._state.phase = Phase.MOVEMENT

    def _generate_summary(
        self,
        resolved: dict[Power, list[tuple[Order, bool]]],
    ) -> str:
        """Generate a summary of the turn."""
        if self._state is None:
            return ""

        lines = [f"=== {self._state.phase_name} ==="]

        for power, power_orders in resolved.items():
            if power_orders:
                success_count = sum(1 for _, s in power_orders if s)
                lines.append(f"{power.full_name}: {success_count}/{len(power_orders)} orders succeeded")

        lines.append("\nSupply Center Counts:")
        for power, state in sorted(self._state.powers.items(), key=lambda x: -x[1].center_count):
            if state.center_count > 0:
                lines.append(f"  {power.full_name}: {state.center_count}")

        return "\n".join(lines)

    async def reset(self) -> GameState:
        """Reset the environment to starting position."""
        await self.initialize()
        return self.get_state()

    async def close(self) -> None:
        """Close the environment."""
        self._state = None
        self._initialized = False

    def get_episode_result(self) -> EpisodeResult:
        """Get result of the current game."""
        if self._state is None:
            raise RuntimeError("No game in progress")

        return EpisodeResult(
            winner=self._state.winner,
            final_state=self._state,
            num_years=self._state.year - 1901,
            center_history=list(self._center_history),
        )
