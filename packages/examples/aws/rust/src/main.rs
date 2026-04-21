//! AWS Lambda handler for elizaOS chat worker (Rust)
//!
//! For local testing, run: cargo run --bin test_local
//! For Lambda deployment, this binary runs as the bootstrap handler.

use eliza_lambda::function_handler;
use lambda_http::{run, service_fn, Error};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Load .env file if present
    let _ = dotenvy::dotenv();

    // Try loading from parent directories
    for path in &["../.env", "../../.env", "../../../.env"] {
        if std::path::Path::new(path).exists() {
            let _ = dotenvy::from_path(path);
            break;
        }
    }

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .json()
        .init();

    info!("Starting elizaOS Lambda handler");

    run(service_fn(function_handler)).await
}
