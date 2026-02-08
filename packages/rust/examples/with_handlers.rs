//! Model Handler Example
//!
//! Run with:
//!   cargo run --example with_handlers --features native

use elizaos::runtime::{AgentRuntime, RuntimeModelHandler, RuntimeOptions};
use elizaos::types::{Bio, Character};
use serde_json::json;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let character = Character {
        name: "HandlerAgent".to_string(),
        bio: Bio::Single("Demonstrates registering a model handler.".to_string()),
        system: Some("Respond briefly and clearly.".to_string()),
        ..Default::default()
    };

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        ..Default::default()
    })
    .await?;

    let handler: RuntimeModelHandler = Box::new(|params| {
        Box::pin(async move {
            let prompt = params
                .get("prompt")
                .and_then(|value| value.as_str())
                .unwrap_or("No prompt provided");
            Ok(format!("Echo: {}", prompt))
        })
    });

    runtime.register_model("TEXT_LARGE", handler).await;

    let response = runtime
        .use_model("TEXT_LARGE", json!({ "prompt": "Hello from Rust!" }))
        .await?;

    println!("Model response: {}", response);
    Ok(())
}
