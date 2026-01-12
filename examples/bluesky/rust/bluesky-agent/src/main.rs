//! Bluesky Agent - A full-featured AI agent running on Bluesky
//!
//! This agent:
//! - Monitors and responds to @mentions
//! - Processes and replies to direct messages
//! - Optionally posts automated content on a schedule

mod character;
mod handlers;

use anyhow::{Context, Result};
use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig};
use elizaos_plugin_bluesky::types::NotificationReason;
use std::sync::Arc;
use std::time::Duration;
use tokio::signal;
use tokio::sync::watch;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use character::AgentCharacter;
use handlers::{handle_create_post, handle_mention_received};

/// Validate required environment variables
fn validate_environment() -> Result<()> {
    let required = ["BLUESKY_HANDLE", "BLUESKY_PASSWORD"];
    let missing: Vec<_> = required
        .iter()
        .filter(|&key| std::env::var(key).is_err())
        .collect();

    if !missing.is_empty() {
        let missing_str: Vec<&str> = missing.into_iter().copied().collect();
        anyhow::bail!(
            "Missing required environment variables: {}. Copy env.example to .env and fill in your credentials.",
            missing_str.join(", ")
        );
    }

    Ok(())
}

/// Main agent loop - polls for notifications
async fn run_agent(
    client: Arc<BlueSkyClient>,
    character: Arc<AgentCharacter>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let config = BlueSkyConfig::from_env()?;
    let poll_interval = Duration::from_secs(config.poll_interval());
    let mut poll_timer = tokio::time::interval(poll_interval);

    let mut last_seen_at: Option<String> = None;

    info!("Starting notification polling (interval: {:?})", poll_interval);

    loop {
        tokio::select! {
            _ = poll_timer.tick() => {
                // Poll for notifications
                match client.get_notifications(50, None).await {
                    Ok((notifications, _cursor)) => {
                        // Filter to new notifications
                        let new_notifications: Vec<_> = if let Some(ref last) = last_seen_at {
                            notifications.iter()
                                .filter(|n| &n.indexed_at > last)
                                .collect()
                        } else {
                            notifications.iter().collect()
                        };

                        if !new_notifications.is_empty() {
                            if let Some(first) = notifications.first() {
                                last_seen_at = Some(first.indexed_at.clone());
                            }

                            for notification in new_notifications {
                                if notification.reason == NotificationReason::Mention
                                    || notification.reason == NotificationReason::Reply
                                {
                                    if let Err(e) = handle_mention_received(&client, &character, notification).await {
                                        error!(error = %e, "Error handling mention");
                                    }
                                }
                            }

                            if let Err(e) = client.update_seen_notifications().await {
                                warn!(error = %e, "Failed to update seen notifications");
                            }
                        }
                    }
                    Err(e) => {
                        error!(error = %e, "Error polling notifications");
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    info!("Shutdown signal received");
                    break;
                }
            }
        }
    }

    Ok(())
}

/// Run automated posting loop
async fn run_automated_posting(
    client: Arc<BlueSkyClient>,
    character: Arc<AgentCharacter>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    use rand::Rng;

    let config = BlueSkyConfig::from_env()?;
    let min_interval = config.post_interval_min();
    let max_interval = config.post_interval_max();

    info!(
        "Starting automated posting (interval: {}s-{}s)",
        min_interval, max_interval
    );

    loop {
        // Random interval between min and max
        let interval_secs = rand::thread_rng().gen_range(min_interval..=max_interval);
        let wait_duration = Duration::from_secs(interval_secs);

        tokio::select! {
            _ = tokio::time::sleep(wait_duration) => {
                if let Err(e) = handle_create_post(&client, &character).await {
                    error!(error = %e, "Error creating automated post");
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    info!("Automated posting shutdown");
                    break;
                }
            }
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load environment variables
    let _ = dotenvy::from_filename("../../.env");
    let _ = dotenvy::dotenv();

    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,bluesky_agent=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("🦋 Starting Bluesky Agent...");

    validate_environment()?;

    // Create character
    let character = Arc::new(AgentCharacter::new());

    // Create Bluesky client
    let config = BlueSkyConfig::from_env()?;
    let client = BlueSkyClient::new(config.clone())?;
    client.authenticate().await?;

    let client = Arc::new(client);

    // Setup shutdown handling
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    info!("✅ Agent '{}' is now running on Bluesky!", character.name);
    info!(
        "   Handle: {}",
        std::env::var("BLUESKY_HANDLE").unwrap_or_default()
    );
    info!("   Polling interval: {}s", config.poll_interval());
    info!("   Automated posting: {}", config.enable_posting());
    info!("   Dry run: {}", config.dry_run());
    info!("   Press Ctrl+C to stop.");

    // Spawn agent tasks
    let agent_handle = {
        let client = Arc::clone(&client);
        let character = Arc::clone(&character);
        let shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            if let Err(e) = run_agent(client, character, shutdown_rx).await {
                error!(error = %e, "Agent error");
            }
        })
    };

    let posting_handle = if config.enable_posting() {
        let client = Arc::clone(&client);
        let character = Arc::clone(&character);
        let shutdown_rx = shutdown_rx.clone();
        Some(tokio::spawn(async move {
            if let Err(e) = run_automated_posting(client, character, shutdown_rx).await {
                error!(error = %e, "Automated posting error");
            }
        }))
    } else {
        None
    };

    // Wait for shutdown signal
    signal::ctrl_c()
        .await
        .context("Failed to listen for ctrl+c")?;

    info!("Shutting down gracefully...");
    let _ = shutdown_tx.send(true);

    // Wait for tasks to complete
    let _ = agent_handle.await;
    if let Some(handle) = posting_handle {
        let _ = handle.await;
    }

    // Close client
    client.close().await;

    info!("👋 Goodbye!");

    Ok(())
}
