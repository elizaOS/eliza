//! Bluesky Agent - A full-featured AI agent running on Bluesky
//!
//! This agent uses the elizaOS runtime pipeline for message processing.

mod character;
mod handlers;

use anyhow::{Context, Result};
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use std::sync::Arc;
use std::time::Duration;
use tokio::signal;
use tokio::sync::Mutex;
use tracing::{error, info, Level};
use tracing_subscriber::FmtSubscriber;

use character::create_character;
use handlers::handle_mention_received;

fn validate_environment() -> Result<()> {
    let required = ["BLUESKY_HANDLE", "BLUESKY_PASSWORD"];
    let missing: Vec<_> = required
        .iter()
        .filter(|key| std::env::var(key).is_err())
        .collect();

    if !missing.is_empty() {
        anyhow::bail!(
            "Missing required environment variables: {:?}\n\
             Copy env.example to .env and fill in your credentials.",
            missing
        );
    }

    let has_model_provider = std::env::var("OPENAI_API_KEY").is_ok()
        || std::env::var("ANTHROPIC_API_KEY").is_ok();

    if !has_model_provider {
        anyhow::bail!(
            "No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY."
        );
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    println!("🦋 Starting Bluesky Agent...\n");

    // Load environment
    let _ = dotenvy::dotenv();
    validate_environment()?;

    // Create the character
    let character = create_character();

    // Create the runtime with plugins
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character.clone()),
        plugins: vec![create_openai_elizaos_plugin()?],
        ..Default::default()
    })
    .await
    .context("Failed to create AgentRuntime")?;

    // Initialize the runtime
    println!("⏳ Initializing runtime...");
    runtime.initialize().await?;

    // Create BlueSky client
    let config = BlueSkyConfig::from_env()?;
    let client = BlueSkyClient::new(config)?;

    // Authenticate (client takes &self for authenticate)
    println!("🔐 Authenticating with Bluesky...");
    client.authenticate().await?;

    let client = Arc::new(Mutex::new(client));

    // Get config values for display
    let handle = std::env::var("BLUESKY_HANDLE").unwrap_or_default();
    let poll_interval: u64 = std::env::var("BLUESKY_POLL_INTERVAL")
        .unwrap_or_else(|_| "60".to_string())
        .parse()
        .unwrap_or(60);
    let enable_posting = std::env::var("BLUESKY_ENABLE_POSTING")
        .map(|v| v != "false")
        .unwrap_or(true);
    let enable_dms = std::env::var("BLUESKY_ENABLE_DMS")
        .map(|v| v != "false")
        .unwrap_or(true);
    let dry_run = std::env::var("BLUESKY_DRY_RUN")
        .map(|v| v == "true")
        .unwrap_or(false);

    println!("\n✅ Agent '{}' is now running on Bluesky!", character.name);
    println!("   Handle: {}", handle);
    println!("   Polling interval: {}s", poll_interval);
    println!("   Automated posting: {}", enable_posting);
    println!("   DM processing: {}", enable_dms);
    println!("   Dry run mode: {}", dry_run);
    println!("\n   Using elizaOS pipeline:");
    println!("   - State composition with providers");
    println!("   - Response generation");
    println!("\n   Press Ctrl+C to stop.\n");

    // Start polling loop
    let poll_duration = Duration::from_secs(poll_interval);

    loop {
        tokio::select! {
            _ = signal::ctrl_c() => {
                info!("Received Ctrl+C, shutting down...");
                break;
            }
            _ = async {
                // Fetch notifications
                let client_guard = client.lock().await;
                match client_guard.get_notifications(50, None).await {
                    Ok((notifications, _cursor)) => {
                        drop(client_guard); // Release lock before processing

                        for notification in notifications {
                            if !notification.is_read {
                                if let Err(e) = handle_mention_received(
                                    &runtime,
                                    &notification,
                                    Arc::clone(&client),
                                ).await {
                                    error!(error = %e, "Error handling notification");
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!(error = %e, "Error fetching notifications");
                    }
                }

                tokio::time::sleep(poll_duration).await;
            } => {}
        }
    }

    // Shutdown
    println!("\n⏳ Shutting down...");
    runtime.stop().await?;
    println!("👋 Goodbye!");

    Ok(())
}
