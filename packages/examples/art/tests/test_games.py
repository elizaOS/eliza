"""
Tests for individual game environments.

Tests each game environment's:
- State representation
- Action parsing
- Environment logic
- Agent behavior
"""

import pytest


class TestGame2048:
    """Tests for 2048 game."""

    @pytest.mark.asyncio
    async def test_state_creation(self):
        """Test 2048 state creation."""
        from elizaos_art.games.game_2048.types import Game2048State

        board = tuple([0] * 16)
        state = Game2048State(
            board=board,
            score=0,
            max_tile=0,
            move_count=0,
            game_over=False,
        )

        assert len(state.board) == 16
        assert state.score == 0
        assert not state.game_over

    @pytest.mark.asyncio
    async def test_state_to_prompt(self):
        """Test state conversion to prompt."""
        from elizaos_art.games.game_2048.types import Game2048State

        board = tuple([2, 0, 0, 0] + [0] * 12)
        state = Game2048State(
            board=board,
            score=0,
            max_tile=2,
            move_count=0,
            game_over=False,
        )

        prompt = state.to_prompt()
        assert "2048" in prompt or "board" in prompt.lower()

    @pytest.mark.asyncio
    async def test_action_parsing(self):
        """Test action parsing from strings."""
        from elizaos_art.games.game_2048.types import Game2048Action

        assert Game2048Action.from_string("UP") == Game2048Action.UP
        assert Game2048Action.from_string("down") == Game2048Action.DOWN
        assert Game2048Action.from_string("LEFT") == Game2048Action.LEFT
        assert Game2048Action.from_string("right") == Game2048Action.RIGHT

    @pytest.mark.asyncio
    async def test_environment_step(self):
        """Test environment step function."""
        from elizaos_art.games.game_2048 import Game2048Environment
        from elizaos_art.games.game_2048.types import Game2048Action

        env = Game2048Environment()
        await env.initialize()

        state = await env.reset(seed=42)
        initial_score = state.score

        new_state, reward, done = await env.step(Game2048Action.DOWN)

        # State should have changed
        assert new_state is not None

    @pytest.mark.asyncio
    async def test_available_actions(self):
        """Test getting available actions."""
        from elizaos_art.games.game_2048 import Game2048Environment
        from elizaos_art.games.game_2048.types import Game2048Action

        env = Game2048Environment()
        await env.initialize()

        state = await env.reset(seed=42)
        actions = env.get_available_actions(state)

        # Should have at least one action
        assert len(actions) > 0
        assert all(isinstance(a, Game2048Action) for a in actions)


class TestTicTacToe:
    """Tests for Tic-Tac-Toe game."""

    @pytest.mark.asyncio
    async def test_state_creation(self):
        """Test Tic-Tac-Toe state creation."""
        from elizaos_art.games.tic_tac_toe.types import TicTacToeState, Player

        board = tuple([0] * 9)
        state = TicTacToeState(
            board=board,
            current_player=Player.X,
            winner=None,
            is_draw=False,
        )

        assert len(state.board) == 9
        assert state.current_player == Player.X
        assert state.winner is None

    @pytest.mark.asyncio
    async def test_win_detection(self):
        """Test win detection logic."""
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment

        env = TicTacToeEnvironment()

        # Check horizontal win for Player X (value = 1)
        from elizaos_art.games.tic_tac_toe.types import Player
        board = [1, 1, 1, 0, 0, 0, 0, 0, 0]
        assert env._is_winner(board, Player.X)

    @pytest.mark.asyncio
    async def test_full_game(self):
        """Test playing a full game."""
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment, TicTacToeHeuristicAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeHeuristicAgent()
        await env.initialize()

        state = await env.reset(seed=42)
        moves = 0

        while not state.is_terminal():
            actions = env.get_available_actions(state)
            if not actions:
                break
            action = await agent.decide(state, actions)
            state, _, _ = await env.step(action)
            moves += 1

        # Game should end
        assert state.is_terminal()
        assert moves <= 9  # Max 9 moves in Tic-Tac-Toe


class TestCodenames:
    """Tests for Codenames game."""

    @pytest.mark.asyncio
    async def test_board_generation(self):
        """Test board generation."""
        from elizaos_art.games.codenames import CodenamesEnvironment
        from elizaos_art.games.codenames.types import CodenamesConfig, Role, CardColor

        config = CodenamesConfig(ai_role=Role.GUESSER, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        await env.initialize()

        state = await env.reset(seed=42)

        # Should have 25 words
        assert len(state.words) == 25
        assert len(state.colors) == 25
        assert len(state.revealed) == 25

    @pytest.mark.asyncio
    async def test_card_reveal(self):
        """Test card revealing logic."""
        from elizaos_art.games.codenames import CodenamesEnvironment
        from elizaos_art.games.codenames.types import CodenamesAction, CodenamesConfig, Role, CardColor

        config = CodenamesConfig(ai_role=Role.GUESSER, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        await env.initialize()

        state = await env.reset(seed=42)

        # Find an unrevealed word
        actions = env.get_available_actions(state)
        word_action = None
        for a in actions:
            if a != CodenamesAction.PASS and a != CodenamesAction.GIVE_CLUE:
                word_action = a
                break

        if word_action:
            new_state, reward, _ = await env.step(word_action)
            # Word should now be revealed
            assert new_state.revealed[word_action.value]


class TestTemporalClue:
    """Tests for Temporal Clue game."""

    @pytest.mark.asyncio
    async def test_puzzle_generation(self):
        """Test puzzle generation."""
        from elizaos_art.games.temporal_clue import TemporalClueEnvironment

        env = TemporalClueEnvironment()
        await env.initialize()

        state = await env.reset(seed=42)

        # Should have events and clues
        assert len(state.events) > 0
        assert len(state.clues) > 0
        assert len(state.unplaced_events) == len(state.events)

    @pytest.mark.asyncio
    async def test_event_placement(self):
        """Test placing events."""
        from elizaos_art.games.temporal_clue import TemporalClueEnvironment
        from elizaos_art.games.temporal_clue.types import TemporalClueAction

        env = TemporalClueEnvironment()
        await env.initialize()

        state = await env.reset(seed=42)
        initial_unplaced = len(state.unplaced_events)

        # Place first event
        actions = env.get_available_actions(state)
        place_action = None
        for a in actions:
            if a != TemporalClueAction.SUBMIT:
                place_action = a
                break

        if place_action:
            new_state, _, _ = await env.step(place_action)
            # Should have one fewer unplaced event
            assert len(new_state.unplaced_events) == initial_unplaced - 1

    @pytest.mark.asyncio
    async def test_submit_answer(self):
        """Test submitting answer."""
        from elizaos_art.games.temporal_clue import TemporalClueEnvironment, TemporalClueHeuristicAgent
        from elizaos_art.games.temporal_clue.types import TemporalClueAction

        env = TemporalClueEnvironment()
        agent = TemporalClueHeuristicAgent()
        await env.initialize()

        state = await env.reset(seed=42)

        # Place all events and submit
        while not state.submitted:
            actions = env.get_available_actions(state)
            if not actions:
                break
            action = await agent.decide(state, actions)
            state, _, _ = await env.step(action)

        # Should be submitted
        assert state.submitted


class TestAgentPrompts:
    """Tests for agent prompt generation."""

    @pytest.mark.asyncio
    async def test_2048_system_prompt(self):
        """Test 2048 agent system prompt."""
        from elizaos_art.games.game_2048 import Game2048Agent

        agent = Game2048Agent()
        prompt = agent.get_system_prompt()

        # Should contain strategy guidance
        assert "corner" in prompt.lower() or "strategy" in prompt.lower() or "tile" in prompt.lower()

    @pytest.mark.asyncio
    async def test_tictactoe_system_prompt(self):
        """Test Tic-Tac-Toe agent system prompt."""
        from elizaos_art.games.tic_tac_toe import TicTacToeAgent

        agent = TicTacToeAgent()
        prompt = agent.get_system_prompt()

        # Should contain game rules
        assert "three" in prompt.lower() or "row" in prompt.lower()

    @pytest.mark.asyncio
    async def test_codenames_system_prompt(self):
        """Test Codenames agent system prompt."""
        from elizaos_art.games.codenames import CodenamesAgent

        agent = CodenamesAgent()
        prompt = agent.get_system_prompt()

        # Should mention roles
        assert "spymaster" in prompt.lower() or "guesser" in prompt.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
