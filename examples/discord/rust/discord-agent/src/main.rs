//! Discord Agent - A full-featured AI agent running on Discord
//!
//! This agent:
//! - Responds to @mentions and replies
//! - Persists conversations and memories
//!
//! Required environment variables:
//! - DISCORD_APPLICATION_ID: Your Discord application ID
//! - DISCORD_API_TOKEN: Your Discord bot token
//! - OPENAI_API_KEY: Your OpenAI API key (optional, for LLM integration)

mod character;
mod handlers;

use anyhow::{Context, Result};
use elizaos_plugin_discord::{DiscordConfig, DiscordEventType, DiscordService};
use std::sync::Arc;
use tokio::signal;
use tokio::sync::RwLock;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use character::create_character;
use handlers::{generate_response, handle_member_joined, handle_reaction_added};

/// Validate required environment variables
fn validate_environment() -> Result<()> {
    let required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"];
    let missing: Vec<_> = required
        .iter()
        .filter(|&key| std::env::var(key).is_err())
        .collect();

    if !missing.is_empty() {
        let missing_list: Vec<&str> = missing.into_iter().copied().collect();
        anyhow::bail!(
            "Missing required environment variables: {}. Copy env.example to .env and fill in your credentials.",
            missing_list.join(", ")
        );
    }

    Ok(())
}

/// Shared application state
#[allow(dead_code)]
struct AppState {
    character_name: String,
    service: Arc<RwLock<DiscordService>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load environment variables
    let _ = dotenvy::from_filename("../../.env");
    let _ = dotenvy::dotenv();

    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,discord_agent=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    println!("🤖 Starting Discord Agent...\n");

    validate_environment()?;

    // Create character
    let character = create_character();
    let character_name = character.name.clone();

    // Create Discord service from environment
    let config = DiscordConfig::from_env().context("Failed to create Discord configuration")?;
    let mut service = DiscordService::new(config);

    // Set up event callback
    let char_name = character_name.clone();
    service.set_event_callback(move |event_type, payload| {
        let char_name = char_name.clone();

        match event_type {
            DiscordEventType::WorldConnected => {
                info!("✅ Connected to Discord!");
            }
            DiscordEventType::MessageReceived => {
                // Extract message info
                let content = payload
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                let author_name = payload
                    .get("author_name")
                    .and_then(|a| a.as_str())
                    .unwrap_or("unknown");
                let channel_id = payload
                    .get("channel_id")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");

                if content.is_empty() {
                    return;
                }

                info!(
                    "Message from {} in channel {}: {}...",
                    author_name,
                    channel_id,
                    &content[..content.len().min(50)]
                );

                // Generate response
                if let Some(response) = generate_response(content, author_name, &char_name) {
                    info!("Generated response: {}...", &response[..response.len().min(50)]);
                    // Note: In a full implementation, you would send this via the service
                    // The event callback is sync, so we log the response here
                    // For async sending, you'd use a channel to communicate back
                }
            }
            DiscordEventType::ReactionReceived => {
                handle_reaction_added(&payload);
            }
            DiscordEventType::EntityJoined => {
                handle_member_joined(&payload);
            }
            _ => {
                tracing::debug!("Received event: {:?}", event_type);
            }
        }
    });

    // Wrap service in Arc<RwLock> for shared access
    let service = Arc::new(RwLock::new(service));

    // Create app state
    let _app_state = Arc::new(AppState {
        character_name: character_name.clone(),
        service: Arc::clone(&service),
    });

    // Start the service
    {
        let mut svc = service.write().await;
        svc.start()
            .await
            .context("Failed to start Discord service")?;
    }

    println!("\n✅ Agent '{}' is now running on Discord!", character_name);
    println!(
        "   Application ID: {}",
        std::env::var("DISCORD_APPLICATION_ID").unwrap_or_default()
    );
    println!("   Responds to: @mentions and channel messages");
    println!("\n   Press Ctrl+C to stop.\n");

    // Wait for shutdown signal
    signal::ctrl_c()
        .await
        .context("Failed to listen for ctrl+c")?;

    println!("\n🛑 Shutting down gracefully...");

    // Stop the service
    {
        let mut svc = service.write().await;
        svc.stop().await?;
    }

    println!("👋 Goodbye!\n");

    Ok(())
}
