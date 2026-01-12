"""
Blackjack strategy implementations.
"""

from __future__ import annotations

from elizaos_atropos_blackjack.types import BlackjackAction, BlackjackState


class BasicStrategy:
    """
    Basic strategy for Blackjack.
    
    This implements the mathematically optimal strategy for single-deck blackjack
    without counting cards. Following this strategy minimizes the house edge.
    """

    # Hard hands (no usable ace)
    # Key: player_sum, Value: dict[dealer_card: action]
    # dealer_card 1 = Ace
    HARD_STRATEGY: dict[int, dict[int, BlackjackAction]] = {
        # Player sum 4-11: Always hit
        4: {i: BlackjackAction.HIT for i in range(1, 11)},
        5: {i: BlackjackAction.HIT for i in range(1, 11)},
        6: {i: BlackjackAction.HIT for i in range(1, 11)},
        7: {i: BlackjackAction.HIT for i in range(1, 11)},
        8: {i: BlackjackAction.HIT for i in range(1, 11)},
        9: {i: BlackjackAction.HIT for i in range(1, 11)},
        10: {i: BlackjackAction.HIT for i in range(1, 11)},
        11: {i: BlackjackAction.HIT for i in range(1, 11)},
        # Player sum 12: Stand on 4-6, hit otherwise
        12: {
            1: BlackjackAction.HIT,
            2: BlackjackAction.HIT,
            3: BlackjackAction.HIT,
            4: BlackjackAction.STICK,
            5: BlackjackAction.STICK,
            6: BlackjackAction.STICK,
            7: BlackjackAction.HIT,
            8: BlackjackAction.HIT,
            9: BlackjackAction.HIT,
            10: BlackjackAction.HIT,
        },
        # Player sum 13-16: Stand on 2-6, hit otherwise
        13: {
            1: BlackjackAction.HIT,
            2: BlackjackAction.STICK,
            3: BlackjackAction.STICK,
            4: BlackjackAction.STICK,
            5: BlackjackAction.STICK,
            6: BlackjackAction.STICK,
            7: BlackjackAction.HIT,
            8: BlackjackAction.HIT,
            9: BlackjackAction.HIT,
            10: BlackjackAction.HIT,
        },
        14: {
            1: BlackjackAction.HIT,
            2: BlackjackAction.STICK,
            3: BlackjackAction.STICK,
            4: BlackjackAction.STICK,
            5: BlackjackAction.STICK,
            6: BlackjackAction.STICK,
            7: BlackjackAction.HIT,
            8: BlackjackAction.HIT,
            9: BlackjackAction.HIT,
            10: BlackjackAction.HIT,
        },
        15: {
            1: BlackjackAction.HIT,
            2: BlackjackAction.STICK,
            3: BlackjackAction.STICK,
            4: BlackjackAction.STICK,
            5: BlackjackAction.STICK,
            6: BlackjackAction.STICK,
            7: BlackjackAction.HIT,
            8: BlackjackAction.HIT,
            9: BlackjackAction.HIT,
            10: BlackjackAction.HIT,
        },
        16: {
            1: BlackjackAction.HIT,
            2: BlackjackAction.STICK,
            3: BlackjackAction.STICK,
            4: BlackjackAction.STICK,
            5: BlackjackAction.STICK,
            6: BlackjackAction.STICK,
            7: BlackjackAction.HIT,
            8: BlackjackAction.HIT,
            9: BlackjackAction.HIT,
            10: BlackjackAction.HIT,
        },
        # Player sum 17+: Always stand
        17: {i: BlackjackAction.STICK for i in range(1, 11)},
        18: {i: BlackjackAction.STICK for i in range(1, 11)},
        19: {i: BlackjackAction.STICK for i in range(1, 11)},
        20: {i: BlackjackAction.STICK for i in range(1, 11)},
        21: {i: BlackjackAction.STICK for i in range(1, 11)},
    }

    # Soft hands (usable ace)
    # Key: player_sum, Value: dict[dealer_card: action]
    SOFT_STRATEGY: dict[int, dict[int, BlackjackAction]] = {
        # Soft 13-17 (A,2 through A,6): Generally hit
        13: {i: BlackjackAction.HIT for i in range(1, 11)},
        14: {i: BlackjackAction.HIT for i in range(1, 11)},
        15: {i: BlackjackAction.HIT for i in range(1, 11)},
        16: {i: BlackjackAction.HIT for i in range(1, 11)},
        17: {i: BlackjackAction.HIT for i in range(1, 11)},
        # Soft 18 (A,7): Stand on 2, 7, 8, hit on 9, 10, A
        18: {
            1: BlackjackAction.HIT,
            2: BlackjackAction.STICK,
            3: BlackjackAction.STICK,
            4: BlackjackAction.STICK,
            5: BlackjackAction.STICK,
            6: BlackjackAction.STICK,
            7: BlackjackAction.STICK,
            8: BlackjackAction.STICK,
            9: BlackjackAction.HIT,
            10: BlackjackAction.HIT,
        },
        # Soft 19-21: Always stand
        19: {i: BlackjackAction.STICK for i in range(1, 11)},
        20: {i: BlackjackAction.STICK for i in range(1, 11)},
        21: {i: BlackjackAction.STICK for i in range(1, 11)},
    }

    @classmethod
    def get_action(cls, state: BlackjackState) -> BlackjackAction:
        """
        Get the optimal action for the given state.
        
        Args:
            state: Current blackjack state
            
        Returns:
            Optimal action according to basic strategy
        """
        player_sum = state.player_sum
        dealer_card = state.dealer_card

        # Select strategy table based on usable ace
        if state.usable_ace:
            strategy = cls.SOFT_STRATEGY.get(player_sum)
        else:
            strategy = cls.HARD_STRATEGY.get(player_sum)

        if strategy is None:
            # Fallback for edge cases
            if player_sum >= 17:
                return BlackjackAction.STICK
            return BlackjackAction.HIT

        return strategy.get(dealer_card, BlackjackAction.HIT)


def optimal_action(state: BlackjackState) -> BlackjackAction:
    """
    Get the optimal action for a blackjack state.
    
    This is a convenience function that uses BasicStrategy.
    
    Args:
        state: Current game state
        
    Returns:
        Optimal action
    """
    return BasicStrategy.get_action(state)


class SimpleStrategy:
    """
    Simple strategy for comparison (always stand on 17+, hit otherwise).
    """

    @staticmethod
    def get_action(state: BlackjackState) -> BlackjackAction:
        """Get action using simple strategy."""
        if state.player_sum >= 17:
            return BlackjackAction.STICK
        return BlackjackAction.HIT


class ConservativeStrategy:
    """
    Conservative strategy (stand on 15+).
    """

    @staticmethod
    def get_action(state: BlackjackState) -> BlackjackAction:
        """Get action using conservative strategy."""
        if state.player_sum >= 15:
            return BlackjackAction.STICK
        return BlackjackAction.HIT


class AggressiveStrategy:
    """
    Aggressive strategy (stand on 19+ only).
    """

    @staticmethod
    def get_action(state: BlackjackState) -> BlackjackAction:
        """Get action using aggressive strategy."""
        if state.player_sum >= 19:
            return BlackjackAction.STICK
        return BlackjackAction.HIT
