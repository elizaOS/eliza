//! Basic Runtime Example
//!
//! Demonstrates creating and using an AgentRuntime with a simple character.
//!
//! Run with:
//! ```bash
//! cargo run --example basic_runtime --features native
//! ```

use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::types::{Bio, Character};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create a simple character
    let character = Character {
        name: "ExampleAgent".to_string(),
        bio: Bio::Single("A helpful example agent for demonstrating the runtime.".to_string()),
        system: Some("You are a helpful assistant. Be concise and friendly.".to_string()),
        ..Default::default()
    };

    println!("Creating agent: {}", character.name);

    // Create the runtime with the character
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        ..Default::default()
    })
    .await?;

    println!("Agent ID: {}", runtime.agent_id);
    println!("Agent created successfully!");

    // Access character info
    let char_guard = runtime.character.read().await;
    println!("Character name: {}", char_guard.name);
    if let Some(system) = &char_guard.system {
        println!("System prompt: {}", system);
    }

    Ok(())
}

