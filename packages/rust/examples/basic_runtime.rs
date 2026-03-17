//! Basic Runtime Example
//!
//! Run with:
//!   cargo run --example basic_runtime --features native

#[cfg(all(feature = "native", not(feature = "wasm")))]
mod inner {
    use elizaos::runtime::{AgentRuntime, RuntimeOptions};
    use elizaos::types::{Bio, Character};
    use std::sync::Arc;

    pub async fn run() -> anyhow::Result<()> {
        let character = Character {
            name: "ExampleAgent".to_string(),
            bio: Bio::Single("A helpful example agent for demonstrating the runtime.".to_string()),
            system: Some("You are a concise, helpful assistant.".to_string()),
            ..Default::default()
        };

        let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            ..Default::default()
        })
        .await?;

        println!("Agent ID: {}", runtime.agent_id);

        let char_guard = runtime.character.read().await;
        println!("Character name: {}", char_guard.name);
        Ok(())
    }
}

#[cfg(all(feature = "native", not(feature = "wasm")))]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    inner::run().await
}

#[cfg(not(all(feature = "native", not(feature = "wasm"))))]
fn main() {
    eprintln!("This example requires the 'native' feature (without 'wasm').");
}
