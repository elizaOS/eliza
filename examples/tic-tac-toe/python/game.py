#!/usr/bin/env python3
"""
elizaOS Tic-Tac-Toe Demo - Python Version

A tic-tac-toe game where an AI agent plays perfectly WITHOUT using an LLM.
Demonstrates:
- elizaOS AgentRuntime (anonymous character)
- Full canonical message processing via runtime.message_service.handle_message()
- Custom model handlers implement perfect play via minimax (NO LLM calls)

Usage:
    python examples/tic-tac-toe/python/game.py
"""

from __future__ import annotations

import asyncio
import math
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import TypeAlias

# Allow running from repo without installing the Python package.
# (If elizaos is already installed, this is a no-op.)
_repo_root = Path(__file__).resolve().parents[3]
_pkg_path = _repo_root / "packages" / "python"
if _pkg_path.exists():
    sys.path.insert(0, str(_pkg_path))

from elizaos.runtime import AgentRuntime
from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.plugin import Plugin
from elizaos.types.primitives import Content, UUID, as_uuid

# Type definitions
Player: TypeAlias = str  # "X" or "O"
Cell: TypeAlias = Player | None
Board: TypeAlias = list[Cell]

WINNING_LINES = [
    [0, 1, 2],  # rows
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],  # columns
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],  # diagonals
    [2, 4, 6],
]


@dataclass
class GameState:
    """Current state of the tic-tac-toe game."""

    board: Board = field(default_factory=lambda: [None] * 9)
    current_player: Player = "X"
    winner: Player | str | None = None  # "X", "O", "draw", or None
    game_over: bool = False
    move_history: list[int] = field(default_factory=list)


def create_empty_board() -> Board:
    """Create an empty 3x3 board."""
    return [None] * 9


def check_winner(board: Board) -> Player | str | None:
    """Check if there's a winner or draw."""
    for a, b, c in WINNING_LINES:
        if board[a] and board[a] == board[b] == board[c]:
            return board[a]
    if all(cell is not None for cell in board):
        return "draw"
    return None


def get_available_moves(board: Board) -> list[int]:
    """Get list of available positions (0-8)."""
    return [i for i, cell in enumerate(board) if cell is None]


# ============================================================================
# MINIMAX ALGORITHM - PERFECT PLAY
# ============================================================================


@dataclass
class MinimaxResult:
    """Result of minimax evaluation."""

    score: int
    move: int


def minimax(board: Board, is_maximizing: bool, ai_player: Player, depth: int = 0) -> MinimaxResult:
    """
    Minimax algorithm for perfect tic-tac-toe play.
    
    Args:
        board: Current board state
        is_maximizing: True if AI's turn (maximizing), False if opponent's turn
        ai_player: The player the AI is playing as ("X" or "O")
        depth: Current recursion depth
    
    Returns:
        MinimaxResult with score and best move
    """
    human_player = "O" if ai_player == "X" else "X"
    winner = check_winner(board)

    # Terminal states
    if winner == ai_player:
        return MinimaxResult(score=10 - depth, move=-1)
    if winner == human_player:
        return MinimaxResult(score=depth - 10, move=-1)
    if winner == "draw":
        return MinimaxResult(score=0, move=-1)

    available_moves = get_available_moves(board)
    best_move = available_moves[0]
    best_score = -math.inf if is_maximizing else math.inf

    for move in available_moves:
        new_board = board.copy()
        new_board[move] = ai_player if is_maximizing else human_player

        result = minimax(new_board, not is_maximizing, ai_player, depth + 1)

        if is_maximizing:
            if result.score > best_score:
                best_score = result.score
                best_move = move
        else:
            if result.score < best_score:
                best_score = result.score
                best_move = move

    return MinimaxResult(score=int(best_score), move=best_move)


def get_optimal_move(board: Board, ai_player: Player) -> int:
    """
    Get the optimal move for the AI player.
    Uses minimax with a position preference for opening moves.
    """
    available_moves = get_available_moves(board)

    # If board is empty, pick center (position 4)
    if len(available_moves) == 9:
        return 4

    # If only one move, take it
    if len(available_moves) == 1:
        return available_moves[0]

    # Use minimax to find the best move
    result = minimax(board, True, ai_player)
    return result.move


# ============================================================================
# BOARD PARSING FROM TEXT
# ============================================================================


def parse_board_from_text(text: str) -> Board | None:
    """
    Parse a tic-tac-toe board from a text prompt.

    Preferred format for this demo:
      BOARD_CELLS: X,O,_,_,O,_,_,_,X
    """
    for line in text.splitlines():
        if "BOARD_CELLS:" not in line.upper():
            continue
        raw = line.split(":", 1)[1].strip()
        parts = [p.strip() for p in raw.split(",") if p.strip()]
        if len(parts) != 9:
            continue
        board: Board = []
        for p in parts:
            v = p.upper()
            if v == "X":
                board.append("X")
            elif v == "O":
                board.append("O")
            else:
                board.append(None)
        return board

    lines = text.split("\n")
    board_chars: list[Cell] = []

    for line in lines:
        # Skip instruction lines
        if "AVAILABLE" in line.upper() or "INSTRUCTION" in line.upper():
            continue

        # Clean the line and look for board patterns
        cleaned = line.replace("|", " ").strip()
        if len(cleaned) >= 3 and all(c.upper() in "XO_. " for c in cleaned):
            for char in cleaned:
                if char.upper() == "X":
                    board_chars.append("X")
                elif char.upper() == "O":
                    board_chars.append("O")
                elif char in "_." :
                    board_chars.append(None)

    if len(board_chars) == 9:
        return board_chars

    return None


def detect_ai_player(text: str) -> Player:
    """Detect which player the AI should play as from the prompt."""
    for line in text.splitlines():
        if "YOU_ARE:" not in line.upper():
            continue
        raw = line.split(":", 1)[1].strip().upper()
        if raw in ("X", "O"):
            return raw
    text_lower = text.lower()
    if "you are o" in text_lower or "play as o" in text_lower or "your mark is o" in text_lower:
        return "O"
    return "X"


# ============================================================================
# TIC-TAC-TOE MODEL HANDLER
# ============================================================================


async def tic_tac_toe_model_handler(
    _runtime: object,
    params: dict[str, object],
) -> str:
    """
    A model handler that implements perfect tic-tac-toe play.
    Parses the board state from the prompt and returns the optimal move.
    """
    # Extract the prompt text
    prompt_text = ""
    prompt_raw = params.get("prompt")
    if isinstance(prompt_raw, str):
        prompt_text = prompt_raw

    if not prompt_text:
        return "Please provide a tic-tac-toe board state."

    # Try to parse the board
    board = parse_board_from_text(prompt_text)
    if board is None:
        return "Could not parse board state. Please provide a 3x3 grid with X, O, and _ for empty."

    # Check if game is already over
    winner = check_winner(board)
    if winner:
        if winner == "draw":
            return "Game is a draw. No moves available."
        return f"Game over. {winner} has won."

    # Determine which player the AI is
    ai_player = detect_ai_player(prompt_text)

    # Get the optimal move
    move = get_optimal_move(board, ai_player)

    # Return canonical Eliza XML so message_service can parse it.
    return "\n".join(
        [
            "<response>",
            "  <thought>Compute perfect move via minimax (no LLM).</thought>",
            "  <actions>REPLY</actions>",
            f"  <text>{move}</text>",
            "</response>",
        ]
    )


# ============================================================================
# GAME CLASS
# ============================================================================


class TicTacToeGame:
    """Tic-tac-toe game engine."""

    def __init__(self) -> None:
        self.state = GameState()

    def get_state(self) -> GameState:
        """Get a copy of current game state."""
        return GameState(
            board=self.state.board.copy(),
            current_player=self.state.current_player,
            winner=self.state.winner,
            game_over=self.state.game_over,
            move_history=self.state.move_history.copy(),
        )

    def make_move(self, position: int) -> bool:
        """Make a move at the given position. Returns True if successful."""
        if (
            position < 0
            or position > 8
            or self.state.board[position] is not None
            or self.state.game_over
        ):
            return False

        self.state.board[position] = self.state.current_player
        self.state.move_history.append(position)

        winner = check_winner(self.state.board)
        if winner:
            self.state.winner = winner
            self.state.game_over = True
        else:
            self.state.current_player = "O" if self.state.current_player == "X" else "X"

        return True

    def format_board(self) -> str:
        """Format the board for display."""
        b = [c if c else "_" for c in self.state.board]
        return f"""
 {b[0]} | {b[1]} | {b[2]}
---+---+---
 {b[3]} | {b[4]} | {b[5]}
---+---+---
 {b[6]} | {b[7]} | {b[8]}

Position reference:
 0 | 1 | 2
---+---+---
 3 | 4 | 5
---+---+---
 6 | 7 | 8
"""

    def reset(self) -> None:
        """Reset the game to initial state."""
        self.state = GameState()


# ============================================================================
# ELIZA AGENT INTEGRATION (Full pipeline)
# ============================================================================


def _string_to_uuid(input_str: str) -> str:
    """Convert a string to a deterministic UUID (matching TypeScript stringToUuid)."""
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_DNS, input_str))


@dataclass
class AgentSession:
    runtime: AgentRuntime
    room_id: UUID
    game_master_id: UUID


def _parse_move(text: str) -> int | None:
    text_stripped = text.strip()
    try:
        move = int(text_stripped)
        return move if 0 <= move <= 8 else None
    except ValueError:
        pass

    # Try extracting from XML
    import re

    match = re.search(r"<text>\s*([0-8])\s*</text>", text_stripped, re.IGNORECASE)
    if match:
        return int(match.group(1))

    match = re.search(r"\b([0-8])\b", text_stripped)
    return int(match.group(1)) if match else None


async def create_runtime() -> AgentSession:
    """
    Create an AgentRuntime with a tic-tac-toe plugin that intercepts TEXT_LARGE/TEXT_SMALL.
    This agent does NOT call an LLM — the model handler is pure minimax.
    """
    plugin = Plugin(
        name="tic-tac-toe",
        description="Perfect tic-tac-toe AI using minimax algorithm - no LLM needed",
        priority=100,
        models={
            ModelType.TEXT_LARGE.value: tic_tac_toe_model_handler,
            ModelType.TEXT_SMALL.value: tic_tac_toe_model_handler,
        },
    )

    runtime = AgentRuntime(
        character=None,  # anonymous Agent-N
        plugins=[plugin],
        # Always respond (ChatGPT mode) to keep game loop deterministic.
        check_should_respond=False,
    )
    await runtime.initialize()

    room_id = as_uuid(_string_to_uuid("tic-tac-toe-room"))
    game_master_id = as_uuid(_string_to_uuid("tic-tac-toe-game-master"))
    return AgentSession(runtime=runtime, room_id=room_id, game_master_id=game_master_id)


async def get_ai_move(session: AgentSession, game: TicTacToeGame, *, ai_player: Player) -> int:
    """Send environment state through Eliza and parse the chosen move."""
    state = game.get_state()
    board_cells = ",".join(c if c else "_" for c in state.board)
    available = ",".join(str(i) for i in get_available_moves(state.board))

    prompt = "\n".join(
        [
            "TIC_TAC_TOE_ENV_UPDATE:",
            f"BOARD_CELLS: {board_cells}",
            f"YOU_ARE: {ai_player}",
            f"AVAILABLE_MOVES: {available}",
            "",
            "Return ONLY the best move as a number 0-8.",
        ]
    )

    import uuid

    message = Memory(
        id=as_uuid(str(uuid.uuid4())),
        entity_id=session.game_master_id,
        room_id=session.room_id,
        content=Content(text=prompt),
        created_at=int(asyncio.get_event_loop().time() * 1000),
    )

    result = await session.runtime.message_service.handle_message(session.runtime, message)
    text = result.response_content.text if result.response_content and result.response_content.text else ""
    move = _parse_move(text) if text else None
    if move is None:
        # Fallback: first available move
        return get_available_moves(state.board)[0]
    return move


# ============================================================================
# DISPLAY FUNCTIONS
# ============================================================================


def show_intro() -> None:
    """Show game introduction."""
    print("\n🎮 elizaOS Tic-Tac-Toe Demo (Python)")
    print("""
╔════════════════════════════════════════════════════════════════════╗
║                   PERFECT TIC-TAC-TOE AI                            ║
╠════════════════════════════════════════════════════════════════════╣
║  This AI plays PERFECTLY using minimax - it NEVER loses!           ║
║                                                                    ║
║  Key features:                                                     ║
║  • NO CHARACTER - uses anonymous agent                             ║
║  • NO LLM - pure algorithmic minimax                               ║
║  • Custom model handlers intercept TEXT_LARGE/TEXT_SMALL           ║
║                                                                    ║
║  The AI will either WIN or DRAW - never lose!                      ║
╚════════════════════════════════════════════════════════════════════╝
""")


def show_board(game: TicTacToeGame) -> None:
    """Display the current board."""
    print(game.format_board())


def show_result(winner: str) -> None:
    """Show the game result."""
    print("\n" + "═" * 40)
    if winner == "draw":
        print("🤝 It's a DRAW!")
    else:
        print(f"🏆 {winner} WINS!")
    print("═" * 40 + "\n")


# ============================================================================
# GAME MODES
# ============================================================================


async def play_human_vs_ai(session: AgentSession, game: TicTacToeGame) -> None:
    """Human vs AI game mode."""
    print("\n📋 You are X, AI is O. You go first!\n")
    show_board(game)

    while not game.state.game_over:
        state = game.get_state()

        if state.current_player == "X":
            # Human's turn
            while True:
                try:
                    move_str = input("Your move (0-8): ")
                    move = int(move_str)
                    if 0 <= move <= 8 and state.board[move] is None:
                        break
                    print("Invalid move! Position taken or out of range.")
                except ValueError:
                    print("Please enter a number 0-8.")
                except EOFError:
                    print("\nGame cancelled.")
                    return

            game.make_move(move)
        else:
            # AI's turn
            print("AI is thinking...")
            ai_move = await get_ai_move(session, game, ai_player="O")
            print(f"AI plays position {ai_move}")
            game.make_move(ai_move)

        show_board(game)

    show_result(game.state.winner)


async def play_ai_vs_ai(session: AgentSession, game: TicTacToeGame) -> None:
    """Watch two AIs play each other."""
    print("\n🤖 Watching two perfect AIs play each other...")
    print("(Both use minimax - this will always be a draw!)\n")
    show_board(game)

    while not game.state.game_over:
        state = game.get_state()
        print(f"{state.current_player} is thinking...")
        move = await get_ai_move(session, game, ai_player=state.current_player)
        print(f"{state.current_player} plays position {move}")
        game.make_move(move)
        show_board(game)

        await asyncio.sleep(0.5)

    show_result(game.state.winner)


async def run_benchmark(session: AgentSession, game: TicTacToeGame) -> None:
    """Run performance benchmark."""
    import time

    print("\n⚡ Running performance benchmark...\n")

    iterations = 100
    start = time.perf_counter()

    for _ in range(iterations):
        game.reset()
        while not game.state.game_over:
            state = game.get_state()
            move = await get_ai_move(session, game, ai_player=state.current_player)
            game.make_move(move)

    elapsed = (time.perf_counter() - start) * 1000

    print(f"✅ Played {iterations} games in {elapsed:.2f}ms")
    print(f"   Average: {elapsed / iterations:.2f}ms per game")
    print("   No LLM calls - pure minimax!")


# ============================================================================
# ENTRY POINT
# ============================================================================


async def main() -> None:
    """Main entry point."""
    show_intro()

    session = await create_runtime()
    print(f"✅ Agent \"{session.runtime.character.name}\" ready! (No LLM - pure minimax)\n")

    print("Choose game mode:")
    print("1. Play vs AI - You are X, AI is O")
    print("2. Watch AI vs AI - Two perfect AIs")
    print("3. Benchmark - Performance test")

    try:
        choice = input("Enter choice (1-3): ").strip()
    except EOFError:
        print("Goodbye! 👋")
        return

    game = TicTacToeGame()

    if choice == "1":
        await play_human_vs_ai(session, game)
    elif choice == "2":
        await play_ai_vs_ai(session, game)
    elif choice == "3":
        await run_benchmark(session, game)
    else:
        print("Invalid choice. Goodbye! 👋")
        return

    await session.runtime.stop()
    print("Thanks for playing! 🎮")


if __name__ == "__main__":
    asyncio.run(main())







