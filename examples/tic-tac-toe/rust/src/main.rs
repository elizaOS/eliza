//! elizaOS Tic-Tac-Toe Demo - Rust Version
//!
//! A tic-tac-toe game where an AI agent plays perfectly WITHOUT using an LLM.
//! Demonstrates:
//! - elizaOS AgentRuntime (anonymous character)
//! - Full message processing via runtime.message_service().handle_message(...)
//! - Custom model handlers that implement perfect play via minimax (NO LLM calls)

use anyhow::Result;
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::types::{Content, Memory, UUID};
use elizaos::types::string_to_uuid;
use elizaos::services::IMessageService;
use elizaos::types::plugin::Plugin;
use serde_json::Value;
use std::future::Future;
use std::io::{self, Write};
use std::pin::Pin;

type Player = char; // 'X' or 'O'
type Cell = Option<Player>;
type Board = [Cell; 9];

const WINNING_LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

fn check_winner(board: &Board) -> Option<Player> {
    for [a, b, c] in WINNING_LINES {
        if let (Some(x), Some(y), Some(z)) = (board[a], board[b], board[c]) {
            if x == y && y == z {
                return Some(x);
            }
        }
    }
    None
}

fn is_draw(board: &Board) -> bool {
    board.iter().all(|c| c.is_some()) && check_winner(board).is_none()
}

fn available_moves(board: &Board) -> Vec<usize> {
    (0..9).filter(|i| board[*i].is_none()).collect()
}

#[derive(Clone, Copy)]
struct MinimaxResult {
    score: i32,
    mv: usize,
}

fn minimax(board: &Board, is_maximizing: bool, ai_player: Player, depth: i32) -> MinimaxResult {
    let human_player: Player = if ai_player == 'X' { 'O' } else { 'X' };

    if let Some(w) = check_winner(board) {
        if w == ai_player {
            return MinimaxResult { score: 10 - depth, mv: 0 };
        }
        if w == human_player {
            return MinimaxResult { score: depth - 10, mv: 0 };
        }
    }
    if is_draw(board) {
        return MinimaxResult { score: 0, mv: 0 };
    }

    let moves = available_moves(board);
    let mut best_mv = moves[0];
    let mut best_score = if is_maximizing { i32::MIN } else { i32::MAX };

    for mv in moves {
        let mut next = *board;
        next[mv] = Some(if is_maximizing { ai_player } else { human_player });
        let result = minimax(&next, !is_maximizing, ai_player, depth + 1);

        if is_maximizing {
            if result.score > best_score {
                best_score = result.score;
                best_mv = mv;
            }
        } else if result.score < best_score {
            best_score = result.score;
            best_mv = mv;
        }
    }

    MinimaxResult {
        score: best_score,
        mv: best_mv,
    }
}

fn optimal_move(board: &Board, ai_player: Player) -> usize {
    let moves = available_moves(board);
    if moves.len() == 9 {
        return 4;
    }
    if moves.len() == 1 {
        return moves[0];
    }
    minimax(board, true, ai_player, 0).mv
}

fn parse_board_cells(prompt: &str) -> Option<Board> {
    for line in prompt.lines() {
        if !line.to_uppercase().contains("BOARD_CELLS:") {
            continue;
        }
        let raw = line.splitn(2, ':').nth(1)?.trim();
        let parts: Vec<&str> = raw.split(',').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
        if parts.len() != 9 {
            continue;
        }
        let mut out: Board = [None; 9];
        for (i, p) in parts.iter().enumerate() {
            match p.to_uppercase().as_str() {
                "X" => out[i] = Some('X'),
                "O" => out[i] = Some('O'),
                _ => out[i] = None,
            }
        }
        return Some(out);
    }
    None
}

fn parse_you_are(prompt: &str) -> Player {
    for line in prompt.lines() {
        if !line.to_uppercase().contains("YOU_ARE:") {
            continue;
        }
        let raw = line.splitn(2, ':').nth(1).unwrap_or("").trim().to_uppercase();
        if raw == "O" {
            return 'O';
        }
        if raw == "X" {
            return 'X';
        }
    }
    'X'
}

fn extract_move_from_response(text: &str) -> Option<usize> {
    let trimmed = text.trim();
    if let Ok(n) = trimmed.parse::<usize>() {
        if n <= 8 {
            return Some(n);
        }
    }
    // XML form: <text>4</text>
    if let Some(start) = trimmed.to_lowercase().find("<text>") {
        let rest = &trimmed[start + "<text>".len()..];
        if let Some(end) = rest.to_lowercase().find("</text>") {
            let inner = rest[..end].trim();
            if let Ok(n) = inner.parse::<usize>() {
                if n <= 8 {
                    return Some(n);
                }
            }
        }
    }
    // Fallback: first digit 0-8
    trimmed
        .chars()
        .find(|c| matches!(c, '0'..='8'))
        .and_then(|c| c.to_digit(10))
        .map(|d| d as usize)
}

fn tic_tac_toe_model_handler(params: Value) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>>
{
    Box::pin(async move {
        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let board = parse_board_cells(prompt).unwrap_or([None; 9]);
        if check_winner(&board).is_some() || is_draw(&board) {
            return Ok("<response><thought>Game over.</thought><actions>REPLY</actions><text>-1</text></response>".to_string());
        }

        let ai_player = parse_you_are(prompt);
        let mv = optimal_move(&board, ai_player);

        Ok(format!(
            "<response>\n  <thought>Compute perfect move via minimax (no LLM).</thought>\n  <actions>REPLY</actions>\n  <text>{}</text>\n</response>",
            mv
        ))
    })
}

fn tic_tac_toe_plugin() -> Plugin {
    let mut plugin = Plugin::new(
        "tic-tac-toe",
        "Perfect tic-tac-toe AI using minimax algorithm - no LLM needed",
    );
    plugin.definition.priority = Some(100);
    plugin
        .model_handlers
        .insert("TEXT_LARGE".to_string(), Box::new(tic_tac_toe_model_handler));
    plugin
        .model_handlers
        .insert("TEXT_SMALL".to_string(), Box::new(tic_tac_toe_model_handler));
    plugin
}

#[derive(Clone)]
struct GameState {
    board: Board,
    current_player: Player,
    winner: Option<Player>,
    game_over: bool,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            board: [None; 9],
            current_player: 'X',
            winner: None,
            game_over: false,
        }
    }
}

struct TicTacToeGame {
    state: GameState,
}

impl TicTacToeGame {
    fn new() -> Self {
        Self {
            state: GameState::default(),
        }
    }

    fn reset(&mut self) {
        self.state = GameState::default();
    }

    fn make_move(&mut self, pos: usize) -> bool {
        if pos > 8 || self.state.game_over || self.state.board[pos].is_some() {
            return false;
        }
        self.state.board[pos] = Some(self.state.current_player);

        if let Some(w) = check_winner(&self.state.board) {
            self.state.winner = Some(w);
            self.state.game_over = true;
        } else if is_draw(&self.state.board) {
            self.state.game_over = true;
        } else {
            self.state.current_player = if self.state.current_player == 'X' {
                'O'
            } else {
                'X'
            };
        }
        true
    }

    fn format_board(&self) -> String {
        let b: Vec<char> = self
            .state
            .board
            .iter()
            .map(|c| c.unwrap_or('_'))
            .collect();
        format!(
            "\n {0} | {1} | {2}\n---+---+---\n {3} | {4} | {5}\n---+---+---\n {6} | {7} | {8}\n\nPosition reference:\n 0 | 1 | 2\n---+---+---\n 3 | 4 | 5\n---+---+---\n 6 | 7 | 8\n",
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8]
        )
    }
}

async fn get_ai_move(runtime: &AgentRuntime, room_id: &UUID, game_master_id: &UUID, game: &TicTacToeGame, ai_player: Player) -> Result<usize> {
    let board_cells = game
        .state
        .board
        .iter()
        .map(|c| c.map(|p| p.to_string()).unwrap_or("_".to_string()))
        .collect::<Vec<String>>()
        .join(",");
    let available = available_moves(&game.state.board)
        .iter()
        .map(|m| m.to_string())
        .collect::<Vec<String>>()
        .join(",");

    let prompt = [
        "TIC_TAC_TOE_ENV_UPDATE:",
        &format!("BOARD_CELLS: {}", board_cells),
        &format!("YOU_ARE: {}", ai_player),
        &format!("AVAILABLE_MOVES: {}", available),
        "",
        "Return ONLY the best move as a number 0-8.",
    ]
    .join("\n");

    let now_ms = chrono_timestamp_ms();
    let mut message = Memory {
        id: Some(UUID::new_v4()),
        entity_id: game_master_id.clone(),
        agent_id: None,
        room_id: room_id.clone(),
        content: Content {
            text: Some(prompt),
            ..Default::default()
        },
        created_at: Some(now_ms),
        embedding: None,
        world_id: None,
        unique: Some(true),
        similarity: None,
        metadata: None,
    };

    let result = runtime
        .message_service()
        .handle_message(runtime, &mut message, None, None)
        .await?;

    let raw = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_default();

    let avail = available_moves(&game.state.board);
    if avail.is_empty() {
        // Should not happen if caller respects game_over, but keep safe.
        return Ok(0);
    }

    let parsed = extract_move_from_response(&raw);
    let mv = parsed.unwrap_or(avail[0]);
    Ok(if avail.contains(&mv) { mv } else { avail[0] })
}

fn chrono_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn parse_args() -> (Option<&'static str>, bool) {
    let mut mode: Option<&'static str> = None;
    let mut no_prompt = false;
    for arg in std::env::args().skip(1) {
        let lower = arg.to_lowercase();
        if lower == "--watch" || lower == "-w" || lower == "watch" {
            mode = Some("watch");
        } else if lower == "--human" || lower == "-h" || lower == "human" || lower == "play" {
            mode = Some("human");
        } else if lower == "--bench" || lower == "-b" || lower == "bench" || lower == "benchmark" {
            mode = Some("bench");
        } else if lower == "--no-prompt" || lower == "-y" {
            no_prompt = true;
        }
    }
    (mode, no_prompt)
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    println!("🎮 elizaOS Tic-Tac-Toe Demo (Rust)\n");

    let (cli_mode, no_prompt) = parse_args();

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: None, // anonymous Agent-N
        plugins: vec![tic_tac_toe_plugin()],
        check_should_respond: Some(false), // always respond for deterministic gameplay
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let room_id = string_to_uuid("tic-tac-toe-room");
    let game_master_id = string_to_uuid("tic-tac-toe-game-master");

    let mut game = TicTacToeGame::new();

    let mut mode = cli_mode.unwrap_or("human");
    if cli_mode.is_none() {
        println!("Choose game mode:");
        println!("1. Play vs AI");
        println!("2. Watch AI vs AI");
        println!("3. Benchmark");
        print!("Enter choice (1-3): ");
        io::stdout().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        mode = match input.trim() {
            "1" => "human",
            "2" => "watch",
            "3" => "bench",
            _ => "human",
        };
    }

    let mut play_again = true;
    while play_again {
        game.reset();

        match mode {
            "human" => {
                println!("\n📋 You are X, AI is O. You go first!");
                println!("{}", game.format_board());
                while !game.state.game_over {
                    if game.state.current_player == 'X' {
                        print!("Your move (0-8): ");
                        io::stdout().flush()?;
                        let mut buf = String::new();
                        io::stdin().read_line(&mut buf)?;
                        if let Ok(pos) = buf.trim().parse::<usize>() {
                            if !game.make_move(pos) {
                                println!("Invalid move.");
                            }
                        } else {
                            println!("Please enter a number 0-8.");
                        }
                    } else {
                        let mv = get_ai_move(&runtime, &room_id, &game_master_id, &game, 'O').await?;
                        println!("AI plays position {}", mv);
                        game.make_move(mv);
                    }
                    println!("{}", game.format_board());
                }
            }
            "watch" => {
                println!("\n🤖 Watching two perfect AIs (always a draw!)");
                println!("{}", game.format_board());
                while !game.state.game_over {
                    let p = game.state.current_player;
                    let mv = get_ai_move(&runtime, &room_id, &game_master_id, &game, p).await?;
                    println!("{} plays position {}", p, mv);
                    if !game.make_move(mv) {
                        // Safety: ensure progress even if response parsing fails.
                        let fallback = available_moves(&game.state.board);
                        if let Some(first) = fallback.first().copied() {
                            game.make_move(first);
                        } else {
                            break;
                        }
                    }
                    println!("{}", game.format_board());
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
            }
            "bench" => {
                println!("\n⚡ Running benchmark...");
                let iterations = 5;
                let start = std::time::Instant::now();
                for _ in 0..iterations {
                    game.reset();
                    while !game.state.game_over {
                        let p = game.state.current_player;
                        let mv = get_ai_move(&runtime, &room_id, &game_master_id, &game, p).await?;
                        if !game.make_move(mv) {
                            let fallback = available_moves(&game.state.board);
                            if let Some(first) = fallback.first().copied() {
                                game.make_move(first);
                            } else {
                                break;
                            }
                        }
                        // Safety: tic-tac-toe must finish within 9 moves.
                        let filled = game.state.board.iter().filter(|c| c.is_some()).count();
                        if filled >= 9 {
                            game.state.game_over = true;
                        }
                    }
                }
                let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
                println!(
                    "✅ Played {} games in {:.2}ms (avg {:.2}ms/game)",
                    iterations,
                    elapsed_ms,
                    elapsed_ms / iterations as f64
                );
            }
            _ => {}
        }

        // Result
        if let Some(w) = game.state.winner {
            println!("🏆 {} WINS!", w);
        } else {
            println!("🤝 It's a DRAW!");
        }

        if no_prompt || cli_mode.is_some() {
            play_again = false;
        } else {
            print!("Play again? (y/N): ");
            io::stdout().flush()?;
            let mut buf = String::new();
            io::stdin().read_line(&mut buf)?;
            play_again = matches!(buf.trim().to_lowercase().as_str(), "y" | "yes");
        }
    }

    runtime.stop().await?;
    Ok(())
}

