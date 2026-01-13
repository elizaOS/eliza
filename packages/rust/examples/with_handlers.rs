//! Runtime with Handlers Example
//!
//! Demonstrates registering custom model handlers and using the runtime.
//!
//! Run with:
//! ```bash
//! cargo run --example with_handlers --features native
//! ```

use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::types::{Bio, Character};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create a character with multiple bio lines
    let character = Character {
        name: "HandlerAgent".to_string(),
        bio: Bio::Multiple(vec![
            "Expert in natural language processing.".to_string(),
            "Helpful and concise in responses.".to_string(),
            "Always provides accurate information.".to_string(),
        ]),
        system: Some("You are a knowledgeable assistant.".to_string()),
        ..Default::default()
    };

    println!("Creating agent with handlers: {}", character.name);

    // Create runtime
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        ..Default::default()
    })
    .await?;

    println!("Agent ID: {}", runtime.agent_id);

    // Register a mock model handler for TEXT_LARGE
    runtime
        .register_model(
            "TEXT_LARGE",
            Box::new(|params| {
                Box::pin(async move {
                    let prompt = params
                        .get("prompt")
                        .and_then(|p| p.as_str())
                        .unwrap_or("No prompt");

                    println!(
                        "Model received prompt: {}...",
                        &prompt[..prompt.len().min(50)]
                    );

                    // In a real app, this would call an LLM API
                    Ok(format!("Mock response to: {}", prompt))
                })
            }),
        )
        .await;

    println!("Model handler registered for TEXT_LARGE");

    // Register an embedding model handler
    runtime
        .register_model(
            "TEXT_EMBEDDING",
            Box::new(|params| {
                Box::pin(async move {
                    let text = params
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("");

                    println!("Embedding text: {}...", &text[..text.len().min(30)]);

                    // Mock embedding - in real app would call embedding API
                    Ok("[0.1, 0.2, 0.3, ...]".to_string())
                })
            }),
        )
        .await;

    println!("Model handler registered for TEXT_EMBEDDING");

    println!("\nRuntime ready for message processing!");

    Ok(())
}
