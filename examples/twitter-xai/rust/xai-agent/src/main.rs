//! X (Twitter) agent example using Grok (xAI) + X API v2 with the full elizaOS pipeline.

mod character;

use anyhow::{Context, Result};
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos_plugin_sql::plugin as sql_plugin;
use elizaos_plugin_xai::{create_xai_elizaos_plugin, start_x_service};
use std::sync::Arc;
use tokio::signal;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

use character::create_character;

fn require_env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("Missing required environment variable: {key}"))
}

fn validate_environment() -> Result<()> {
    require_env("XAI_API_KEY")?;

    let auth_mode = std::env::var("X_AUTH_MODE").unwrap_or_else(|_| "env".to_string());
    if auth_mode.to_lowercase() != "env" {
        anyhow::bail!("This example expects X_AUTH_MODE=env (OAuth 1.0a). Got {auth_mode}");
    }

    require_env("X_API_KEY")?;
    require_env("X_API_SECRET")?;
    require_env("X_ACCESS_TOKEN")?;
    require_env("X_ACCESS_TOKEN_SECRET")?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    println!("𝕏 Starting X (Grok) Agent...\n");

    let _ = dotenvy::dotenv();
    validate_environment()?;

    let character = create_character();
    let runtime = Arc::new(
        AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            plugins: vec![sql_plugin(), create_xai_elizaos_plugin()?],
            ..Default::default()
        })
        .await
        .context("Failed to create AgentRuntime")?,
    );

    println!("⏳ Initializing runtime...");
    runtime.initialize().await?;

    // Fail fast if SQL isn't active (X service persists cursor + dedupe memories).
    runtime
        .get_adapter()
        .context("SQL adapter not available; ensure elizaos-plugin-sql is configured")?;

    let _x_service = start_x_service(Arc::clone(&runtime)).await?;
    info!("X service started. Waiting for Ctrl+C...");

    signal::ctrl_c().await?;
    info!("Received Ctrl+C, shutting down...");
    runtime.stop().await?;
    Ok(())
}

