//! Basic Runtime Example
//!
//! Run with:
//!   cargo run --example basic_runtime --features native

use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::types::{Bio, Character};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let character = Character {
        name: "ExampleAgent".to_string(),
        bio: Bio::Single("A helpful example agent for demonstrating the runtime.".to_string()),
        system: Some("You are a concise, helpful assistant.".to_string()),
        ..Default::default()
    };

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        ..Default::default()
    })
    .await?;

    println!("Agent ID: {}", runtime.agent_id);

    let char_guard = runtime.character.read().await;
    println!("Character name: {}", char_guard.name);
    Ok(())
}
