"""
Type definitions for the Diplomacy environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TypeAlias


class Power(str, Enum):
    """The seven great powers in Diplomacy."""

    AUSTRIA = "AUS"
    ENGLAND = "ENG"
    FRANCE = "FRA"
    GERMANY = "GER"
    ITALY = "ITA"
    RUSSIA = "RUS"
    TURKEY = "TUR"

    @property
    def full_name(self) -> str:
        """Get full nation name."""
        names = {
            "AUS": "Austria-Hungary",
            "ENG": "England",
            "FRA": "France",
            "GER": "Germany",
            "ITA": "Italy",
            "RUS": "Russia",
            "TUR": "Turkey",
        }
        return names[self.value]


class UnitType(str, Enum):
    """Unit types in Diplomacy."""

    ARMY = "A"
    FLEET = "F"


class OrderType(str, Enum):
    """Types of orders in Diplomacy."""

    HOLD = "HOLD"
    MOVE = "MOVE"
    SUPPORT = "SUPPORT"
    CONVOY = "CONVOY"
    BUILD = "BUILD"
    DISBAND = "DISBAND"
    RETREAT = "RETREAT"


class Phase(str, Enum):
    """Game phases."""

    MOVEMENT = "MOVEMENT"
    RETREAT = "RETREAT"
    ADJUSTMENT = "ADJUSTMENT"


class Season(str, Enum):
    """Game seasons."""

    SPRING = "SPRING"
    FALL = "FALL"
    WINTER = "WINTER"


# Province name type
Province: TypeAlias = str


@dataclass
class Unit:
    """A military unit."""

    type: UnitType
    location: Province
    power: Power

    def __str__(self) -> str:
        return f"{self.type.value} {self.location}"

    def short(self) -> str:
        """Short representation."""
        return f"{self.type.value}-{self.location}"


@dataclass
class Order:
    """An order for a unit."""

    unit: Unit
    order_type: OrderType
    target: Province | None = None
    support_unit: Unit | None = None
    support_target: Province | None = None
    via_convoy: bool = False

    def __str__(self) -> str:
        base = f"{self.unit.type.value} {self.unit.location}"

        if self.order_type == OrderType.HOLD:
            return f"{base} HOLD"
        elif self.order_type == OrderType.MOVE:
            via = " via CONVOY" if self.via_convoy else ""
            return f"{base} -> {self.target}{via}"
        elif self.order_type == OrderType.SUPPORT:
            if self.support_target:
                return f"{base} S {self.support_unit} -> {self.support_target}"
            return f"{base} S {self.support_unit} HOLD"
        elif self.order_type == OrderType.CONVOY:
            return f"{base} C {self.support_unit} -> {self.support_target}"
        elif self.order_type == OrderType.BUILD:
            return f"BUILD {self.unit.type.value} {self.target}"
        elif self.order_type == OrderType.DISBAND:
            return f"DISBAND {base}"
        elif self.order_type == OrderType.RETREAT:
            return f"{base} RETREAT -> {self.target}"

        return f"{base} {self.order_type.value}"


@dataclass
class Message:
    """A diplomatic message between powers."""

    sender: Power
    recipient: Power
    content: str
    phase: str
    timestamp: int = 0

    def __str__(self) -> str:
        return f"[{self.sender.value} -> {self.recipient.value}]: {self.content}"


@dataclass
class PowerState:
    """State for a single power."""

    power: Power
    units: list[Unit]
    supply_centers: list[Province]
    home_centers: list[Province]
    is_eliminated: bool = False

    @property
    def unit_count(self) -> int:
        """Number of units."""
        return len(self.units)

    @property
    def center_count(self) -> int:
        """Number of supply centers."""
        return len(self.supply_centers)

    @property
    def adjustment_needed(self) -> int:
        """Number of units to build (positive) or disband (negative)."""
        return self.center_count - self.unit_count

    def get_units_in_province(self, province: Province) -> Unit | None:
        """Get unit in a province, if any."""
        for unit in self.units:
            if unit.location == province:
                return unit
        return None


@dataclass
class GameState:
    """Complete game state."""

    year: int
    season: Season
    phase: Phase
    powers: dict[Power, PowerState]
    pending_retreats: dict[Province, list[Province]] = field(default_factory=dict)
    message_history: list[Message] = field(default_factory=list)
    order_history: list[dict[Power, list[Order]]] = field(default_factory=list)

    @property
    def phase_name(self) -> str:
        """Get human-readable phase name."""
        return f"{self.season.value} {self.year} {self.phase.value}"

    @property
    def is_game_over(self) -> bool:
        """Check if game is over (someone has 18+ centers)."""
        for power_state in self.powers.values():
            if power_state.center_count >= 18:
                return True
        return False

    @property
    def winner(self) -> Power | None:
        """Get winner if game is over."""
        for power, state in self.powers.items():
            if state.center_count >= 18:
                return power
        return None

    @property
    def active_powers(self) -> list[Power]:
        """Get list of non-eliminated powers."""
        return [p for p, s in self.powers.items() if not s.is_eliminated]

    def get_all_units(self) -> list[Unit]:
        """Get all units on the board."""
        units = []
        for power_state in self.powers.values():
            units.extend(power_state.units)
        return units

    def get_unit_at(self, province: Province) -> Unit | None:
        """Get unit at a province."""
        for power_state in self.powers.values():
            unit = power_state.get_units_in_province(province)
            if unit:
                return unit
        return None

    def get_center_count(self) -> dict[Power, int]:
        """Get supply center counts for all powers."""
        return {p: s.center_count for p, s in self.powers.items()}


@dataclass
class StepResult:
    """Result of taking a step in the environment."""

    state: GameState
    orders_resolved: dict[Power, list[tuple[Order, bool]]]  # Order and success
    retreats_needed: dict[Power, list[Unit]]
    messages: list[Message]
    summary: str

    @property
    def phase_complete(self) -> bool:
        """Check if the phase is complete."""
        return len(self.retreats_needed) == 0


@dataclass
class EpisodeResult:
    """Result of a complete game."""

    winner: Power | None
    final_state: GameState
    num_years: int
    center_history: list[dict[Power, int]]

    @property
    def is_draw(self) -> bool:
        """Check if game ended in a draw."""
        return self.winner is None
