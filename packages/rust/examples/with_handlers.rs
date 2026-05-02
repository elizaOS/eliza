//! Model Handler Example
//!
//! Run with:
//!   cargo run --example with_handlers --features native

#[cfg(all(feature = "native", not(feature = "wasm")))]
mod inner {
    use elizaos::runtime::{AgentRuntime, RuntimeModelHandler, RuntimeOptions};
    use elizaos::types::{Bio, Character};
    use serde_json::json;
    use std::sync::Arc;

    pub async fn run() -> anyhow::Result<()> {
        let character = Character {
            name: "HandlerAgent".to_string(),
            bio: Bio::Single("Demonstrates registering a model handler.".to_string()),
            system: Some("Respond briefly and clearly.".to_string()),
            ..Default::default()
        };

        let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
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
