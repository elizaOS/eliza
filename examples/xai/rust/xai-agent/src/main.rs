//! X (Twitter) agent example using Grok (xAI) + X API v2 with the full elizaOS pipeline.

mod character;

use anyhow::{Context, Result};
use elizaos::{
    runtime::{AgentRuntime, RuntimeOptions},
    services::IMessageService,
    types::{
        primitives::string_to_uuid,
        ChannelType,
        Content,
        Entity,
        Room,
        UUID,
        World,
    },
};
use elizaos_plugin_sql::plugin as sql_plugin;
use elizaos_plugin_xai::{create_xai_elizaos_plugin, TwitterClient, TwitterConfig};
use elizaos_plugin_xai::error::XAIError;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::signal;
use tokio::sync::Mutex;
use tracing::{info, warn, Level};
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

fn truncate_to_280(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 280 {
        return trimmed.to_string();
    }
    // Conservative: truncate by bytes is unsafe; truncate by chars.
    let mut out = String::new();
    for (i, ch) in trimmed.chars().enumerate() {
        if i >= 277 {
            break;
        }
        out.push(ch);
    }
    out.push_str("...");
    out
}

fn parse_snowflake(id: &str) -> u128 {
    id.parse::<u128>().unwrap_or(0)
}

fn cursor_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".x_last_seen_id")
}

fn load_cursor() -> u128 {
    let p = cursor_path();
    match fs::read_to_string(p) {
        Ok(s) => parse_snowflake(s.trim()),
        Err(_) => 0,
    }
}

fn save_cursor(value: u128) -> Result<()> {
    fs::write(cursor_path(), value.to_string()).context("Failed to write cursor file")
}

fn random_minutes(min_key: &str, max_key: &str, def_min: u64, def_max: u64) -> f64 {
    let min_val: u64 = std::env::var(min_key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(def_min);
    let max_val: u64 = std::env::var(max_key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(def_max);
    if min_val >= max_val {
        return min_val as f64;
    }
    let r = rand::random::<f64>();
    (min_val as f64) + r * ((max_val - min_val) as f64)
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

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character.clone()),
        plugins: vec![sql_plugin(), create_xai_elizaos_plugin()?],
        ..Default::default()
    })
    .await
    .context("Failed to create AgentRuntime")?;

    println!("⏳ Initializing runtime...");
    runtime.initialize().await?;

    // Ensure a single world exists for X conversations.
    let world_id = string_to_uuid("x-world");
    let adapter = runtime
        .get_adapter()
        .context("SQL adapter not available; ensure elizaos-plugin-sql is configured")?;

    if adapter.get_world(&world_id).await?.is_none() {
        adapter
            .create_world(&World {
                id: world_id.clone(),
                name: Some("X".to_string()),
                agent_id: runtime.agent_id.clone(),
                message_server_id: Some(world_id.clone()),
                metadata: None,
            })
            .await?;
    }

    // Ensure the agent itself exists as an entity so it can participate in rooms.
    if adapter.get_entity(&runtime.agent_id).await?.is_none() {
        adapter
            .create_entity(&Entity {
                id: Some(runtime.agent_id.clone()),
                names: vec![character.name.clone()],
                metadata: std::collections::HashMap::new(),
                agent_id: runtime.agent_id.clone(),
                components: None,
            })
            .await?;
    }

    let config = TwitterConfig::from_env()?;
    let x = Arc::new(Mutex::new(TwitterClient::new(config)?));
    let me = { x.lock().await.me().await? };
    info!("Authenticated to X as @{} ({})", me.username, me.id);

    let mut last_seen: u128 = load_cursor();

    loop {
        tokio::select! {
            _ = signal::ctrl_c() => {
                info!("Received Ctrl+C, shutting down...");
                break;
            }
            _ = async {
                let query = format!("@{}", me.username);
                let resp = { x.lock().await.search_posts(&query, 50, Some("recency")).await };
                let resp = match resp {
                    Ok(r) => r,
                    Err(XAIError::TwitterApiError { status: 429, .. }) => {
                        warn!("Rate limited (429). Backing off for 60s.");
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        return;
                    }
                    Err(e) => {
                        warn!("X API error: {}", e);
                        tokio::time::sleep(Duration::from_secs(15)).await;
                        return;
                    }
                };

                let mut candidates: Vec<(u128, elizaos_plugin_xai::types::Post)> = resp.posts
                    .into_iter()
                    .filter(|p| p.author_id.as_deref().unwrap_or("") != me.id)
                    .filter(|p| p.username.to_lowercase() != me.username.to_lowercase())
                    .map(|p| (parse_snowflake(&p.id), p))
                    .filter(|(id, _)| *id > last_seen)
                    .collect();

                candidates.sort_by_key(|(id, _)| *id);

                for (id_num, post) in candidates {
                    if let Err(e) = handle_mention(&runtime, Arc::clone(&x), &me.username, &world_id, post).await {
                        warn!("Error handling mention: {}", e);
                    }
                    if id_num > last_seen {
                        last_seen = id_num;
                    }
                }

                if let Err(e) = save_cursor(last_seen) {
                    warn!("Failed to persist cursor: {}", e);
                    return;
                }

                let minutes = random_minutes("X_ENGAGEMENT_INTERVAL_MIN", "X_ENGAGEMENT_INTERVAL_MAX", 20, 40);
                let seconds = (minutes * 60.0).max(30.0) as u64;
                tokio::time::sleep(Duration::from_secs(seconds)).await;
            } => {}
        }
    }

    println!("\n⏳ Shutting down...");
    runtime.stop().await?;
    println!("👋 Goodbye!");
    Ok(())
}

async fn handle_mention(
    runtime: &AgentRuntime,
    x: Arc<Mutex<TwitterClient>>,
    me_username: &str,
    world_id: &UUID,
    post: elizaos_plugin_xai::types::Post,
) -> Result<()> {
    let adapter = runtime
        .get_adapter()
        .context("SQL adapter not available; ensure elizaos-plugin-sql is configured")?;

    let author_id = post
        .author_id
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let entity_id = string_to_uuid(&format!("x-user:{author_id}"));
    let room_key = post
        .conversation_id
        .clone()
        .unwrap_or_else(|| post.id.clone());
    let room_id = string_to_uuid(&format!("x-room:{room_key}"));

    // Dedupe: if we've already stored the incoming post memory, skip.
    let incoming_id = string_to_uuid(&format!("x-post:{}", post.id));
    if adapter.get_memory_by_id(&incoming_id).await?.is_some() {
        return Ok(());
    }

    // Ensure author entity exists.
    if adapter.get_entity(&entity_id).await?.is_none() {
        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            "x".to_string(),
            serde_json::json!({ "id": author_id, "username": post.username }),
        );
        adapter
            .create_entity(&Entity {
                id: Some(entity_id.clone()),
                names: vec![
                    if post.name.is_empty() {
                        post.username.clone()
                    } else {
                        post.name.clone()
                    },
                    post.username.clone(),
                ],
                metadata,
                agent_id: runtime.agent_id.clone(),
                components: None,
            })
            .await?;
    }

    // Ensure room exists.
    if adapter.get_room(&room_id).await?.is_none() {
        adapter
            .create_room(&Room {
                id: room_id.clone(),
                name: Some(format!("x:{room_key}")),
                agent_id: Some(runtime.agent_id.clone()),
                source: "x".to_string(),
                room_type: ChannelType::Feed,
                channel_id: Some(room_key.clone()),
                message_server_id: Some(world_id.clone()),
                world_id: Some(world_id.clone()),
                metadata: None,
            })
            .await?;
    }

    // Ensure participants.
    let _ = adapter.add_participant(&entity_id, &room_id).await?;
    let _ = adapter.add_participant(&runtime.agent_id, &room_id).await?;

    let mut message = elizaos::types::Memory::new(
        entity_id,
        room_id,
        Content {
            text: Some(post.text.clone()),
            source: Some("x".to_string()),
            url: Some(post.permanent_url.clone()),
            channel_type: Some(ChannelType::Feed),
            ..Default::default()
        },
    );
    message.id = Some(incoming_id.clone());

    let post_id = post.id.clone();
    let room_id_for_cb = message.room_id.clone();
    let agent_id = runtime.agent_id.clone();
    let incoming_id_for_cb = incoming_id.clone();
    let me_username = me_username.to_string();
    let x = Arc::clone(&x);

    // Process through FULL pipeline.
    let result = runtime
        .message_service()
        .handle_message(runtime, &mut message, None, None)
        .await?;

    if !result.did_respond {
        return Ok(());
    }

    let reply_text = match result
        .response_content
        .as_ref()
        .and_then(|c| c.text.as_ref())
        .map(|s| s.as_str())
    {
        Some(t) if !t.trim().is_empty() => truncate_to_280(t),
        _ => return Ok(()),
    };

    // Post the reply (respects X_DRY_RUN via config.dry_run).
    let created = x
        .lock()
        .await
        .create_reply(&reply_text, &post_id)
        .await?;

    let response_url = format!("https://x.com/{}/status/{}", me_username, created.id);
    let mut response_memory = elizaos::types::Memory::new(
        agent_id,
        room_id_for_cb,
        Content {
            text: Some(reply_text),
            source: Some("x".to_string()),
            url: Some(response_url),
            in_reply_to: Some(incoming_id_for_cb),
            channel_type: Some(ChannelType::Feed),
            ..Default::default()
        },
    );
    response_memory.id = Some(string_to_uuid(&format!("x-post:{}", created.id)));

    // Persist the outbound reply to the message table.
    adapter.create_memory(&response_memory, "messages").await?;

    Ok(())
}

