/**
 * elizaOS Tic-Tac-Toe Demo
 *
 * A tic-tac-toe game where an AI agent plays perfectly WITHOUT using an LLM.
 * Demonstrates:
 * - elizaOS runtime with NO character (uses anonymous character)
 * - Custom model handlers that implement perfect play via minimax
 * - No LLM calls - pure algorithmic decision making
 * - plugin-sql for persistence (PGLite in-memory)
 *
 * Usage:
 *   bun run examples/tic-tac-toe/typescript/game.ts
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || "fatal";

import * as clack from "@clack/prompts";
import {
  AgentRuntime,
  bootstrapPlugin,
  type Plugin,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";

// ============================================================================
// TIC-TAC-TOE ENGINE
// ============================================================================

type Player = "X" | "O";
type Cell = Player | null;
type Board = [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

interface GameState {
  board: Board;
  currentPlayer: Player;
  winner: Player | "draw" | null;
  gameOver: boolean;
  moveHistory: number[];
}

const WINNING_LINES = [
  [0, 1, 2], // rows
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6], // columns
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8], // diagonals
  [2, 4, 6],
];

function createEmptyBoard(): Board {
  return [null, null, null, null, null, null, null, null, null];
}

function checkWinner(board: Board): Player | "draw" | null {
  for (const [a, b, c] of WINNING_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a] as Player;
    }
  }
  if (board.every((cell) => cell !== null)) {
    return "draw";
  }
  return null;
}

function getAvailableMoves(board: Board): number[] {
  return board
    .map((cell, idx) => (cell === null ? idx : -1))
    .filter((idx) => idx !== -1);
}

// ============================================================================
// MINIMAX ALGORITHM - PERFECT PLAY
// ============================================================================

interface MinimaxResult {
  score: number;
  move: number;
}

function minimax(
  board: Board,
  isMaximizing: boolean,
  aiPlayer: Player,
  depth: number = 0
): MinimaxResult {
  const humanPlayer: Player = aiPlayer === "X" ? "O" : "X";
  const winner = checkWinner(board);

  // Terminal states
  if (winner === aiPlayer) return { score: 10 - depth, move: -1 };
  if (winner === humanPlayer) return { score: depth - 10, move: -1 };
  if (winner === "draw") return { score: 0, move: -1 };

  const availableMoves = getAvailableMoves(board);
  let bestMove = availableMoves[0];
  let bestScore = isMaximizing ? -Infinity : Infinity;

  for (const move of availableMoves) {
    const newBoard = [...board] as Board;
    newBoard[move] = isMaximizing ? aiPlayer : humanPlayer;

    const result = minimax(newBoard, !isMaximizing, aiPlayer, depth + 1);

    if (isMaximizing) {
      if (result.score > bestScore) {
        bestScore = result.score;
        bestMove = move;
      }
    } else {
      if (result.score < bestScore) {
        bestScore = result.score;
        bestMove = move;
      }
    }
  }

  return { score: bestScore, move: bestMove };
}

/**
 * Get the optimal move for the AI player.
 * Uses minimax with a position preference for opening moves.
 */
function getOptimalMove(board: Board, aiPlayer: Player): number {
  const availableMoves = getAvailableMoves(board);

  // If board is empty, pick center (position 4)
  if (availableMoves.length === 9) {
    return 4;
  }

  // If only one move, take it
  if (availableMoves.length === 1) {
    return availableMoves[0];
  }

  // Use minimax to find the best move
  const result = minimax(board, true, aiPlayer);
  return result.move;
}

// ============================================================================
// BOARD PARSING FROM TEXT PROMPTS
// ============================================================================

/**
 * Parse a tic-tac-toe board from a text prompt.
 * Looks for patterns like:
 * - "X | O | _" or "X O _"
 * - Position numbers: "1: X, 2: O, 3: _, ..."
 * - Array notation: ["X", "O", null, ...]
 */
function parseBoardFromText(text: string): Board | null {
  // Try to find board representation in the text
  const lines = text.split("\n");

  // Look for a 3x3 grid pattern
  const gridPattern = /[XO_.\s|]+/gi;
  const boardChars: Cell[] = [];

  for (const line of lines) {
    // Skip lines that are clearly not board lines
    if (line.includes("AVAILABLE") || line.includes("INSTRUCTION")) continue;

    // Extract X, O, and empty markers
    const cleaned = line.replace(/[|]/g, " ").trim();
    if (/^[XO_.\s]+$/i.test(cleaned) && cleaned.length >= 3) {
      for (const char of cleaned) {
        if (char === "X" || char === "x") boardChars.push("X");
        else if (char === "O" || char === "o") boardChars.push("O");
        else if (char === "_" || char === ".") boardChars.push(null);
      }
    }
  }

  if (boardChars.length === 9) {
    return boardChars as Board;
  }

  // Try JSON array format
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0].replace(/'/g, '"'));
      if (arr.length === 9) {
        return arr.map((v: string | null) =>
          v === "X" || v === "O" ? v : null
        ) as Board;
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // Try to find individual cell references like "position 0: X"
  const positionPattern = /position\s*(\d)\s*[:=]\s*([XO_])/gi;
  const positions = new Map<number, Cell>();
  let match;
  while ((match = positionPattern.exec(text)) !== null) {
    const pos = parseInt(match[1]);
    const val = match[2].toUpperCase();
    positions.set(pos, val === "X" || val === "O" ? (val as Player) : null);
  }

  if (positions.size >= 1) {
    const board: Board = createEmptyBoard();
    for (const [pos, val] of positions) {
      if (pos >= 0 && pos < 9) {
        board[pos] = val;
      }
    }
    return board;
  }

  return null;
}

/**
 * Detect which player the AI should play as from the prompt.
 */
function detectAIPlayer(text: string): Player {
  const textLower = text.toLowerCase();
  // If prompt mentions "you are O" or "play as O"
  if (
    textLower.includes("you are o") ||
    textLower.includes("play as o") ||
    textLower.includes("your mark is o")
  ) {
    return "O";
  }
  // Default to X (first player)
  return "X";
}

// ============================================================================
// CUSTOM MODEL HANDLERS - NO LLM
// ============================================================================

/**
 * A model handler that implements perfect tic-tac-toe play.
 * Parses the board state from the prompt and returns the optimal move.
 */
async function ticTacToeModelHandler(
  _runtime: IAgentRuntime,
  params: { prompt?: string; messages?: Array<{ content: string }> }
): Promise<string> {
  // Extract the prompt text
  let promptText = "";
  if (params.prompt) {
    promptText = params.prompt;
  } else if (params.messages && params.messages.length > 0) {
    promptText = params.messages.map((m) => m.content).join("\n");
  }

  if (!promptText) {
    return "Please provide a tic-tac-toe board state.";
  }

  // Try to parse the board
  const board = parseBoardFromText(promptText);
  if (!board) {
    return "Could not parse board state. Please provide a 3x3 grid with X, O, and _ for empty.";
  }

  // Check if game is already over
  const winner = checkWinner(board);
  if (winner) {
    if (winner === "draw") {
      return "Game is a draw. No moves available.";
    }
    return `Game over. ${winner} has won.`;
  }

  // Determine which player the AI is
  const aiPlayer = detectAIPlayer(promptText);

  // Get the optimal move
  const move = getOptimalMove(board, aiPlayer);

  // Return just the move number
  return String(move);
}

// ============================================================================
// TIC-TAC-TOE PLUGIN
// ============================================================================

/**
 * A plugin that provides perfect tic-tac-toe play without any LLM.
 * Registers custom model handlers for TEXT_LARGE and TEXT_SMALL.
 */
const ticTacToePlugin: Plugin = {
  name: "tic-tac-toe",
  description: "Perfect tic-tac-toe AI using minimax algorithm - no LLM needed",
  priority: 100, // High priority to override any LLM-based handlers

  models: {
    [ModelType.TEXT_LARGE]: ticTacToeModelHandler,
    [ModelType.TEXT_SMALL]: ticTacToeModelHandler,
  },
};

// ============================================================================
// GAME CLASS
// ============================================================================

class TicTacToeGame {
  private state: GameState;

  constructor() {
    this.state = {
      board: createEmptyBoard(),
      currentPlayer: "X",
      winner: null,
      gameOver: false,
      moveHistory: [],
    };
  }

  getState(): GameState {
    return { ...this.state, board: [...this.state.board] as Board };
  }

  makeMove(position: number): boolean {
    if (
      position < 0 ||
      position > 8 ||
      this.state.board[position] !== null ||
      this.state.gameOver
    ) {
      return false;
    }

    this.state.board[position] = this.state.currentPlayer;
    this.state.moveHistory.push(position);

    const winner = checkWinner(this.state.board);
    if (winner) {
      this.state.winner = winner;
      this.state.gameOver = true;
    } else {
      this.state.currentPlayer = this.state.currentPlayer === "X" ? "O" : "X";
    }

    return true;
  }

  formatBoard(): string {
    const b = this.state.board.map((c) => c || "_");
    return `
 ${b[0]} | ${b[1]} | ${b[2]}
---+---+---
 ${b[3]} | ${b[4]} | ${b[5]}
---+---+---
 ${b[6]} | ${b[7]} | ${b[8]}

Position reference:
 0 | 1 | 2
---+---+---
 3 | 4 | 5
---+---+---
 6 | 7 | 8
`;
  }

  reset(): void {
    this.state = {
      board: createEmptyBoard(),
      currentPlayer: "X",
      winner: null,
      gameOver: false,
      moveHistory: [],
    };
  }
}

// ============================================================================
// MAIN GAME LOGIC
// ============================================================================

interface GameSession {
  runtime: AgentRuntime;
  game: TicTacToeGame;
}

async function createSession(): Promise<GameSession> {
  const task = clack.spinner();
  task.start("Initializing tic-tac-toe agent...");

  // Create runtime with NO character (anonymous) and NO LLM
  // Uses our custom tic-tac-toe plugin for model handling
  const runtime = new AgentRuntime({
    // No character - uses anonymous Agent-N
    plugins: [sqlPlugin, bootstrapPlugin, ticTacToePlugin],
    settings: {
      PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR || "memory://",
    },
  });

  await runtime.initialize();

  const game = new TicTacToeGame();

  task.stop(
    `✅ Agent "${runtime.character.name}" ready! (No LLM - pure minimax)`
  );

  return { runtime, game };
}

async function getAIMove(session: GameSession): Promise<number> {
  const { runtime, game } = session;
  const state = game.getState();

  // Build prompt for our custom handler
  const boardStr = state.board.map((c) => c || "_").join(" ");
  const prompt = `
CURRENT BOARD STATE:
${boardStr.slice(0, 5)}
${boardStr.slice(6, 11)}
${boardStr.slice(12)}

You are playing as ${state.currentPlayer}.
Your mark is ${state.currentPlayer}.

Choose the optimal position (0-8) for your next move.
`;

  // Call our custom model handler (NOT an LLM!)
  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  // Parse the move from response
  const move = parseInt(response.trim());
  if (isNaN(move) || move < 0 || move > 8) {
    // Fallback: pick first available
    const available = getAvailableMoves(state.board);
    return available[0];
  }

  return move;
}

// ============================================================================
// DISPLAY FUNCTIONS
// ============================================================================

function showIntro(): void {
  clack.intro("🎮 elizaOS Tic-Tac-Toe Demo");
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   PERFECT TIC-TAC-TOE AI                            ║
╠════════════════════════════════════════════════════════════════════╣
║  This AI plays PERFECTLY using minimax - it NEVER loses!           ║
║                                                                    ║
║  Key features:                                                     ║
║  • NO CHARACTER - uses anonymous agent                             ║
║  • NO LLM - pure algorithmic minimax                               ║
║  • Custom model handlers intercept TEXT_LARGE/TEXT_SMALL           ║
║  • Uses plugin-sql for persistence                                 ║
║                                                                    ║
║  The AI will either WIN or DRAW - never lose!                      ║
╚════════════════════════════════════════════════════════════════════╝
`);
}

function showBoard(game: TicTacToeGame): void {
  console.log(game.formatBoard());
}

function showResult(winner: "X" | "O" | "draw"): void {
  console.log("\n" + "═".repeat(40));
  if (winner === "draw") {
    console.log("🤝 It's a DRAW!");
  } else {
    console.log(`🏆 ${winner} WINS!`);
  }
  console.log("═".repeat(40) + "\n");
}

// ============================================================================
// GAME MODES
// ============================================================================

async function playHumanVsAI(session: GameSession): Promise<void> {
  const { game } = session;

  console.log("\n📋 You are X, AI is O. You go first!\n");
  showBoard(game);

  while (!game.getState().gameOver) {
    const state = game.getState();

    if (state.currentPlayer === "X") {
      // Human's turn
      const input = await clack.text({
        message: "Your move (0-8):",
        placeholder: "Enter position number",
        validate: (value) => {
          const pos = parseInt(value);
          if (isNaN(pos) || pos < 0 || pos > 8) {
            return "Please enter a number 0-8";
          }
          if (state.board[pos] !== null) {
            return "Position already taken!";
          }
        },
      });

      if (clack.isCancel(input)) {
        console.log("Game cancelled.");
        return;
      }

      game.makeMove(parseInt(input));
    } else {
      // AI's turn
      const spinner = clack.spinner();
      spinner.start("AI is thinking...");

      const aiMove = await getAIMove(session);

      spinner.stop(`AI plays position ${aiMove}`);
      game.makeMove(aiMove);
    }

    showBoard(game);
  }

  showResult(game.getState().winner as "X" | "O" | "draw");
}

async function playAIVsAI(session: GameSession): Promise<void> {
  const { game } = session;

  console.log("\n🤖 Watching two perfect AIs play each other...\n");
  console.log("(Both use minimax - this will always be a draw!)\n");
  showBoard(game);

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  while (!game.getState().gameOver) {
    const state = game.getState();

    const spinner = clack.spinner();
    spinner.start(`${state.currentPlayer} is thinking...`);

    const move = await getAIMove(session);

    await delay(500); // Small delay for dramatic effect
    spinner.stop(`${state.currentPlayer} plays position ${move}`);

    game.makeMove(move);
    showBoard(game);

    await delay(300);
  }

  showResult(game.getState().winner as "X" | "O" | "draw");
}

async function runBenchmark(session: GameSession): Promise<void> {
  console.log("\n⚡ Running performance benchmark...\n");

  const iterations = 100;
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    session.game.reset();
    while (!session.game.getState().gameOver) {
      const move = await getAIMove(session);
      session.game.makeMove(move);
    }
  }

  const elapsed = performance.now() - start;

  console.log(`✅ Played ${iterations} games in ${elapsed.toFixed(2)}ms`);
  console.log(`   Average: ${(elapsed / iterations).toFixed(2)}ms per game`);
  console.log(`   No LLM calls - pure minimax!`);
}

// ============================================================================
// COMMAND LINE PARSING
// ============================================================================

type GameMode = "human" | "watch" | "bench";

function parseArgs(): { mode?: GameMode; noPrompt?: boolean } {
  const args = process.argv.slice(2);
  let mode: GameMode | undefined;
  let noPrompt = false;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === "--watch" || lower === "-w" || lower === "watch") {
      mode = "watch";
    } else if (lower === "--human" || lower === "-h" || lower === "human" || lower === "play") {
      mode = "human";
    } else if (lower === "--bench" || lower === "-b" || lower === "bench" || lower === "benchmark") {
      mode = "bench";
    } else if (lower === "--no-prompt" || lower === "-y") {
      noPrompt = true;
    }
  }

  return { mode, noPrompt };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  const { mode: cliMode, noPrompt } = parseArgs();

  showIntro();

  const session = await createSession();

  let mode: GameMode;

  if (cliMode) {
    // Use CLI-specified mode
    mode = cliMode;
    console.log(`\n🎯 Mode: ${mode} (from command line)\n`);
  } else {
    // Interactive mode selection
    const selected = await clack.select({
      message: "Choose game mode:",
      options: [
        { value: "human", label: "Play vs AI", hint: "You are X, AI is O" },
        { value: "watch", label: "Watch AI vs AI", hint: "Two perfect AIs" },
        { value: "bench", label: "Benchmark", hint: "Performance test" },
      ],
    });

    if (clack.isCancel(selected)) {
      clack.outro("Goodbye! 👋");
      await session.runtime.stop();
      return;
    }
    mode = selected as GameMode;
  }

  let playAgain = true;

  while (playAgain) {
    session.game.reset();

    switch (mode) {
      case "human":
        await playHumanVsAI(session);
        break;
      case "watch":
        await playAIVsAI(session);
        break;
      case "bench":
        await runBenchmark(session);
        break;
    }

    // Skip "play again" prompt if --no-prompt or in non-interactive mode
    if (noPrompt || cliMode) {
      playAgain = false;
    } else {
      const again = await clack.confirm({
        message: "Play again?",
      });

      if (clack.isCancel(again) || !again) {
        playAgain = false;
      }
    }
  }

  await session.runtime.stop();
  clack.outro("Thanks for playing! 🎮");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

