"""
Texas Hold'em poker environment.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos_atropos_holdem.types import (
    Card,
    Action,
    ActionType,
    Phase,
    PlayerState,
    GameState,
    HandResult,
    HandRank,
    Chips,
)
from elizaos_atropos_holdem.deck import create_deck
from elizaos_atropos_holdem.hand_evaluator import evaluate_hand

if TYPE_CHECKING:
    pass


class HoldemEnvironment:
    """
    Texas Hold'em poker environment.
    
    Implements No-Limit Texas Hold'em rules for 2-9 players.
    
    Example:
        >>> env = HoldemEnvironment(num_players=2, starting_stack=1000)
        >>> await env.initialize()
        >>> state = await env.reset()
        >>> result = await env.step(Action(ActionType.CALL, 10))
    """

    def __init__(
        self,
        num_players: int = 2,
        starting_stack: Chips = 1000,
        small_blind: Chips = 5,
        big_blind: Chips = 10,
    ) -> None:
        """
        Initialize the Hold'em environment.
        
        Args:
            num_players: Number of players (2-9)
            starting_stack: Starting chip stack per player
            small_blind: Small blind amount
            big_blind: Big blind amount
        """
        if not 2 <= num_players <= 9:
            raise ValueError("Number of players must be 2-9")

        self._num_players = num_players
        self._starting_stack = starting_stack
        self._small_blind = small_blind
        self._big_blind = big_blind

        # Game state
        self._deck = create_deck()
        self._community_cards: list[Card] = []
        self._pot: Chips = 0
        self._current_bet: Chips = 0
        self._players: list[PlayerState] = []
        self._current_player: int = 0
        self._button: int = 0
        self._phase = Phase.PREFLOP
        self._betting_history: list[list[Action]] = []
        self._hand_over = False
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._players = [
            PlayerState(
                position=i,
                stack=self._starting_stack,
                hole_cards=None,
            )
            for i in range(self._num_players)
        ]
        self._initialized = True

    async def reset(self, move_button: bool = True) -> GameState:
        """
        Start a new hand.
        
        Args:
            move_button: Whether to move the button
            
        Returns:
            Initial game state
        """
        # Move button
        if move_button:
            self._button = (self._button + 1) % self._num_players

        # Reset state
        self._deck = create_deck()
        self._community_cards = []
        self._pot = 0
        self._current_bet = self._big_blind
        self._phase = Phase.PREFLOP
        self._betting_history = [[]]
        self._hand_over = False

        # Reset players
        for player in self._players:
            player.hole_cards = None
            player.bet_this_round = 0
            player.total_bet = 0
            player.folded = False
            player.all_in = False

        # Post blinds
        sb_pos = (self._button + 1) % self._num_players
        bb_pos = (self._button + 2) % self._num_players

        if self._num_players == 2:
            # Heads-up: button posts small blind
            sb_pos = self._button
            bb_pos = (self._button + 1) % self._num_players

        self._post_blind(sb_pos, self._small_blind)
        self._post_blind(bb_pos, self._big_blind)

        # Deal hole cards
        for player in self._players:
            cards = self._deck.deal_many(2)
            player.hole_cards = (cards[0], cards[1])

        # Set first player to act
        self._current_player = (bb_pos + 1) % self._num_players
        self._skip_inactive_players()

        return self._get_state()

    def _post_blind(self, position: int, amount: Chips) -> None:
        """Post a blind bet."""
        player = self._players[position]
        actual_amount = min(amount, player.stack)
        player.stack -= actual_amount
        player.bet_this_round = actual_amount
        player.total_bet = actual_amount
        self._pot += actual_amount

        if player.stack == 0:
            player.all_in = True

    def _get_state(self) -> GameState:
        """Get current game state."""
        return GameState(
            phase=self._phase,
            community_cards=list(self._community_cards),
            pot=self._pot,
            current_bet=self._current_bet,
            players=[
                PlayerState(
                    position=p.position,
                    stack=p.stack,
                    hole_cards=p.hole_cards,
                    bet_this_round=p.bet_this_round,
                    total_bet=p.total_bet,
                    folded=p.folded,
                    all_in=p.all_in,
                )
                for p in self._players
            ],
            current_player=self._current_player,
            button=self._button,
            small_blind=self._small_blind,
            big_blind=self._big_blind,
            betting_history=list(self._betting_history),
            hand_over=self._hand_over,
        )

    async def step(self, action: Action) -> GameState:
        """
        Execute an action.
        
        Args:
            action: The action to take
            
        Returns:
            New game state
        """
        if self._hand_over:
            return self._get_state()

        player = self._players[self._current_player]

        # Record action
        self._betting_history[-1].append(action)

        # Execute action
        if action.action_type == ActionType.FOLD:
            player.folded = True

        elif action.action_type == ActionType.CHECK:
            pass  # No change

        elif action.action_type == ActionType.CALL:
            call_amount = min(self._current_bet - player.bet_this_round, player.stack)
            player.stack -= call_amount
            player.bet_this_round += call_amount
            player.total_bet += call_amount
            self._pot += call_amount
            if player.stack == 0:
                player.all_in = True

        elif action.action_type == ActionType.RAISE:
            raise_to = action.amount
            additional = raise_to - player.bet_this_round
            actual_amount = min(additional, player.stack)
            player.stack -= actual_amount
            player.bet_this_round += actual_amount
            player.total_bet += actual_amount
            self._pot += actual_amount
            self._current_bet = player.bet_this_round
            if player.stack == 0:
                player.all_in = True

        elif action.action_type == ActionType.ALL_IN:
            amount = player.stack
            player.bet_this_round += amount
            player.total_bet += amount
            self._pot += amount
            player.stack = 0
            player.all_in = True
            if player.bet_this_round > self._current_bet:
                self._current_bet = player.bet_this_round

        # Check for hand ending conditions
        active_players = [p for p in self._players if not p.folded]

        if len(active_players) == 1:
            # Everyone else folded
            self._hand_over = True
            return self._get_state()

        # Move to next player
        self._current_player = (self._current_player + 1) % self._num_players
        self._skip_inactive_players()

        # Check if betting round is complete
        if self._is_betting_round_complete():
            self._advance_phase()

        return self._get_state()

    def _skip_inactive_players(self) -> None:
        """Skip folded or all-in players."""
        start = self._current_player
        while True:
            player = self._players[self._current_player]
            if player.is_active:
                break
            self._current_player = (self._current_player + 1) % self._num_players
            if self._current_player == start:
                break

    def _is_betting_round_complete(self) -> bool:
        """Check if the betting round is complete."""
        active_players = [p for p in self._players if p.is_active]

        # Only one player left who can act
        if len(active_players) <= 1:
            return True

        # All active players have matched the current bet
        for player in active_players:
            if player.bet_this_round < self._current_bet:
                return False

        # Check if everyone has acted at least once this round
        num_actions = len(self._betting_history[-1])
        if num_actions < len(active_players):
            return False

        return True

    def _advance_phase(self) -> None:
        """Advance to the next phase."""
        # Reset bets for new round
        for player in self._players:
            player.bet_this_round = 0
        self._current_bet = 0

        if self._phase == Phase.PREFLOP:
            self._phase = Phase.FLOP
            self._deck.burn()
            self._community_cards.extend(self._deck.deal_many(3))
        elif self._phase == Phase.FLOP:
            self._phase = Phase.TURN
            self._deck.burn()
            self._community_cards.append(self._deck.deal())
        elif self._phase == Phase.TURN:
            self._phase = Phase.RIVER
            self._deck.burn()
            self._community_cards.append(self._deck.deal())
        elif self._phase == Phase.RIVER:
            self._phase = Phase.SHOWDOWN
            self._hand_over = True

        # Start new betting history for this round
        if self._phase != Phase.SHOWDOWN:
            self._betting_history.append([])

            # Set first to act (first active player after button)
            self._current_player = (self._button + 1) % self._num_players
            self._skip_inactive_players()

    def get_hand_result(self) -> HandResult:
        """
        Get the result of the completed hand.
        
        Returns:
            HandResult with winners and payouts
        """
        active_players = [p for p in self._players if not p.folded]

        if len(active_players) == 1:
            # Everyone else folded
            winner = active_players[0]
            payouts = {p.position: -p.total_bet for p in self._players}
            payouts[winner.position] = self._pot - winner.total_bet

            return HandResult(
                winners=[winner.position],
                payouts=payouts,
                winning_hand=None,
                showed_down=False,
            )

        # Showdown - find best hand
        best_rank = HandRank.HIGH_CARD
        best_values: list[int] = []
        winners: list[int] = []

        for player in active_players:
            if player.hole_cards is None:
                continue

            all_cards = list(player.hole_cards) + self._community_cards
            rank, values = evaluate_hand(all_cards)

            if rank > best_rank or (rank == best_rank and values > best_values):
                best_rank = rank
                best_values = values
                winners = [player.position]
            elif rank == best_rank and values == best_values:
                winners.append(player.position)

        # Calculate payouts
        payouts = {p.position: -p.total_bet for p in self._players}
        pot_share = self._pot // len(winners)
        remainder = self._pot % len(winners)

        for i, winner_pos in enumerate(winners):
            extra = 1 if i < remainder else 0
            payouts[winner_pos] = pot_share + extra - self._players[winner_pos].total_bet

        return HandResult(
            winners=winners,
            payouts=payouts,
            winning_hand=best_rank,
            showed_down=True,
        )

    def format_state(self, player_position: int | None = None) -> str:
        """Format game state for display."""
        lines = []

        # Phase and pot
        lines.append(f"Phase: {self._phase.value.upper()}")
        lines.append(f"Pot: {self._pot}")

        # Community cards
        if self._community_cards:
            cards_str = " ".join(str(c) for c in self._community_cards)
            lines.append(f"Board: [{cards_str}]")

        # Players
        lines.append("\nPlayers:")
        for player in self._players:
            status = "🎯" if player.position == self._current_player else "  "
            if player.folded:
                status = "❌"
            elif player.all_in:
                status = "💰"

            hole_cards = ""
            if player.hole_cards and (player_position is None or player.position == player_position):
                hole_cards = f" [{player.hole_cards[0]} {player.hole_cards[1]}]"
            elif player.hole_cards:
                hole_cards = " [🂠 🂠]"

            lines.append(
                f"  {status} P{player.position}: ${player.stack:>4} "
                f"(bet: ${player.bet_this_round}){hole_cards}"
            )

        return "\n".join(lines)

    async def close(self) -> None:
        """Close the environment."""
        self._initialized = False
