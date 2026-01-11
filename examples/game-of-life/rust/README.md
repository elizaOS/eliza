# Tic-Tac-Toe Demo - Rust Version

A tic-tac-toe game demonstrating perfect play using minimax algorithm without any LLM.

## Status

Coming soon! The Rust implementation will mirror the TypeScript version with:

- No character (anonymous agent)
- Custom model handlers for TEXT_LARGE/TEXT_SMALL
- Minimax algorithm for perfect play
- Zero LLM calls

## Planned Structure

```rust
// Custom model handler - no LLM
async fn tic_tac_toe_model_handler(
    _runtime: &AgentRuntime,
    params: serde_json::Value,
) -> Result<String> {
    let prompt = params["prompt"].as_str().unwrap_or("");
    let board = parse_board_from_text(prompt)?;
    let ai_player = detect_ai_player(prompt);
    let optimal_move = minimax(&board, true, ai_player);
    Ok(optimal_move.to_string())
}

// Plugin registration
let plugin = Plugin {
    name: "tic-tac-toe",
    models: [(ModelType::TEXT_SMALL, tic_tac_toe_model_handler)].into(),
    priority: 100,
    ..Default::default()
};

// Anonymous agent
let runtime = AgentRuntime::new(RuntimeOptions {
    character: None,  // Uses Agent-N
    plugins: vec![local_db_plugin, bootstrap_plugin, plugin],
    ..Default::default()
}).await?;
```
