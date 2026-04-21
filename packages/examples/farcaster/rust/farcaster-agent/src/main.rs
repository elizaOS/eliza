//! Farcaster Agent Example (Rust)
//!
//! A minimal elizaOS agent that monitors and responds to Farcaster mentions
//! using OpenAI for text generation and the full elizaOS message pipeline.
//!
//! Usage:
//!     cargo run --release
//!
//! Required environment variables:
//!     - OPENAI_API_KEY: OpenAI API key
//!     - FARCASTER_FID: Your Farcaster ID
//!     - FARCASTER_SIGNER_UUID: Neynar signer UUID
//!     - FARCASTER_NEYNAR_API_KEY: Neynar API key

mod character;

use anyhow::{Context, Result};
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::services::IMessageService;
use elizaos::types::environment::{ChannelType, Entity, Room, World};
use elizaos::types::memory::Memory;
use elizaos::types::primitives::{Content, MentionContext, UUID};
use elizaos_plugin_farcaster::{FarcasterConfig, FarcasterService};
use elizaos_plugin_openai::plugin as openai_plugin;
use elizaos_plugin_sql::plugin as sql_plugin;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};
use tracing::{error, info, warn, Level};
use tracing_subscriber::FmtSubscriber;

use character::create_character;

/// Load and validate required environment variables.
fn require_env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("Missing required environment variable: {name}"))
}

/// Validate all required environment variables.
fn validate_environment() -> Result<()> {
    require_env("OPENAI_API_KEY")?;
    require_env("FARCASTER_FID")?;
    require_env("FARCASTER_SIGNER_UUID")?;
    require_env("FARCASTER_NEYNAR_API_KEY")?;
    Ok(())
}

/// Truncate text to Farcaster's 320 character limit.
fn truncate_to_320(text: &str) -> String {
    if text.len() <= 320 {
        return text.to_string();
    }
    let trimmed = text.trim();
    if trimmed.len() <= 320 {
        return trimmed.to_string();
    }
    format!("{}...", &trimmed[..317])
}

/// Generate a deterministic UUID from a string.
fn string_to_uuid(input: &str) -> UUID {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    let hash = hasher.finish();

    // Create a UUID from the hash bytes
    let bytes = hash.to_be_bytes();
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes[0..8].copy_from_slice(&bytes);
    uuid_bytes[8..16].copy_from_slice(&bytes);
    // Set version 4 and variant bits
    uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x40;
    uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;

    UUID::from_bytes(uuid_bytes)
}

/// Get current timestamp in milliseconds.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Ensure the Farcaster world exists in elizaOS.
async fn ensure_world(runtime: &AgentRuntime, world_id: &UUID) -> Result<()> {
    let world = World {
        id: world_id.clone(),
        name: "Farcaster".to_string(),
        agent_id: runtime.agent_id().clone(),
        message_server_id: Some(world_id.clone()),
        ..Default::default()
    };
    runtime.ensure_world_exists(&world).await?;

    // Ensure agent entity exists
    let agent_entity = Entity {
        id: runtime.agent_id().clone(),
        names: vec![runtime.character().name.clone()],
        agent_id: Some(runtime.agent_id().clone()),
        ..Default::default()
    };
    runtime.create_entities(&[agent_entity]).await?;

    Ok(())
}

/// Ensure room and participants exist.
async fn ensure_room_and_participants(
    runtime: &AgentRuntime,
    world_id: &UUID,
    room_id: &UUID,
    room_name: &str,
    user_entity: &Entity,
) -> Result<()> {
    runtime.create_entities(&[user_entity.clone()]).await?;

    let room = Room {
        id: room_id.clone(),
        name: room_name.to_string(),
        agent_id: runtime.agent_id().clone(),
        source: Some("farcaster".to_string()),
        channel_type: ChannelType::Feed,
        channel_id: Some(room_name.to_string()),
        message_server_id: Some(world_id.clone()),
        world_id: Some(world_id.clone()),
        ..Default::default()
    };
    runtime.ensure_room_exists(&room).await?;

    runtime
        .ensure_participant_in_room(&user_entity.id, room_id)
        .await?;
    runtime
        .ensure_participant_in_room(runtime.agent_id(), room_id)
        .await?;

    Ok(())
}

/// Process a single Farcaster mention through the full elizaOS pipeline.
async fn process_mention(
    runtime: &AgentRuntime,
    farcaster_service: &FarcasterService,
    cast: &elizaos_plugin_farcaster::Cast,
    world_id: &UUID,
    my_fid: u64,
    dry_run: bool,
    processed: &RwLock<HashSet<String>>,
) -> Result<()> {
    // Skip self-casts
    if cast.author_fid == my_fid {
        return Ok(());
    }

    // Skip already processed
    {
        let seen = processed.read().await;
        if seen.contains(&cast.hash) {
            return Ok(());
        }
    }

    let incoming_memory_id = string_to_uuid(&format!("farcaster-cast:{}", cast.hash));

    // Check if already in memory
    if let Some(adapter) = runtime.get_adapter() {
        if adapter.get_memory_by_id(&incoming_memory_id).await?.is_some() {
            let mut seen = processed.write().await;
            seen.insert(cast.hash.clone());
            return Ok(());
        }
    }

    let room_key = cast
        .in_reply_to
        .as_ref()
        .map(|p| p.hash.clone())
        .unwrap_or_else(|| cast.hash.clone());
    let room_id = string_to_uuid(&format!("farcaster-room:{}", room_key));

    let author_username = cast.profile.username.clone();
    let author_display_name = cast.profile.name.clone();

    let user_entity = Entity {
        id: string_to_uuid(&format!("farcaster-user:{}", cast.author_fid)),
        names: vec![author_display_name.clone(), author_username.clone()]
            .into_iter()
            .filter(|n| !n.is_empty())
            .collect(),
        agent_id: Some(runtime.agent_id().clone()),
        metadata: Some(serde_json::json!({
            "farcaster": {
                "fid": cast.author_fid,
                "username": author_username
            }
        })),
        ..Default::default()
    };

    ensure_room_and_participants(runtime, world_id, &room_id, &format!("farcaster:{}", room_key), &user_entity).await?;

    let url = format!(
        "https://warpcast.com/{}/{}",
        author_username,
        &cast.hash[..10.min(cast.hash.len())]
    );

    let mut message = Memory {
        id: Some(incoming_memory_id.clone()),
        entity_id: user_entity.id.clone(),
        agent_id: runtime.agent_id().clone(),
        room_id: room_id.clone(),
        world_id: Some(world_id.clone()),
        content: Content {
            text: Some(cast.text.clone()),
            source: Some("farcaster".to_string()),
            url: Some(url),
            channel_type: Some("FEED".to_string()),
            mention_context: Some(MentionContext {
                is_mention: true,
                is_reply: false,
                is_thread: false,
                mention_type: Some("platform_mention".to_string()),
            }),
            ..Default::default()
        },
        created_at: Some(now_ms()),
        ..Default::default()
    };

    info!(
        "Processing mention from @{}: {}",
        author_username,
        &cast.text[..50.min(cast.text.len())]
    );

    // Process through elizaOS message service
    let message_service = runtime.message_service();

    // Create callback to handle response
    let cast_hash = cast.hash.clone();
    let author_fid = cast.author_fid;
    let service = farcaster_service;
    let dry_run_flag = dry_run;

    let result = message_service
        .handle_message(runtime, &mut message, None, None)
        .await?;

    if result.did_respond {
        if let Some(ref response_content) = result.response_content {
            if let Some(ref text) = response_content.text {
                let reply_text = truncate_to_320(text);
                info!("Response: {}", &reply_text[..100.min(reply_text.len())]);

                if dry_run_flag {
                    info!("[DRY RUN] Would reply: {}", reply_text);
                } else {
                    match service.send_cast(&reply_text, Some(&cast_hash)).await {
                        Ok(_) => {
                            info!("Posted reply to @{}", author_username);
                        }
                        Err(e) => {
                            error!("Failed to reply to {}: {}", cast_hash, e);
                        }
                    }
                }
            }
        }
    }

    // Mark as processed
    {
        let mut seen = processed.write().await;
        seen.insert(cast.hash.clone());
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

    // Load environment from .env files
    let _ = dotenvy::from_filename("../../.env");
    let _ = dotenvy::dotenv();

    println!("🟣 Starting Farcaster Agent...\n");

    // Validate required environment variables
    if let Err(e) = validate_environment() {
        eprintln!("❌ {}", e);
        eprintln!(
            "   Copy examples/farcaster/env.example to examples/farcaster/.env and fill in credentials."
        );
        std::process::exit(1);
    }

    let dry_run = std::env::var("FARCASTER_DRY_RUN")
        .map(|v| v.to_lowercase() != "false")
        .unwrap_or(true);
    let poll_interval = std::env::var("FARCASTER_POLL_INTERVAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120u64);

    // Get character configuration
    let character = create_character();
    let character_name = character
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("FarcasterBot");

    // Create the agent runtime with plugins
    let runtime = Arc::new(
        AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            plugins: vec![sql_plugin(), openai_plugin()?],
            ..Default::default()
        })
        .await
        .context("Failed to create AgentRuntime")?,
    );

    println!("⏳ Initializing runtime...");
    runtime.initialize().await?;

    // Fail fast if SQL isn't active
    runtime
        .get_adapter()
        .context("SQL adapter not available; ensure elizaos-plugin-sql is configured")?;

    // Initialize Farcaster service
    let farcaster_config = FarcasterConfig::from_env()?;
    let farcaster_service = FarcasterService::new(farcaster_config.clone());
    farcaster_service.start().await?;

    let fid = farcaster_service.fid();
    let world_id = string_to_uuid("farcaster-world");
    ensure_world(&runtime, &world_id).await?;

    println!("\n✅ Agent \"{}\" is now running on Farcaster.", character_name);
    println!("   Farcaster FID: {}", fid);
    println!("   Dry run mode: {}", dry_run);
    println!("   Polling interval: {}s", poll_interval);
    println!("\n   Press Ctrl+C to stop.\n");

    // Track processed cast hashes
    let processed: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));

    // Polling loop
    let running = Arc::new(RwLock::new(true));
    let running_clone = Arc::clone(&running);

    // Spawn Ctrl+C handler
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("\nSIGINT received. Shutting down...");
        let mut r = running_clone.write().await;
        *r = false;
    });

    let mut poll_timer = interval(Duration::from_secs(poll_interval));

    while *running.read().await {
        poll_timer.tick().await;

        if !*running.read().await {
            break;
        }

        // Fetch mentions
        match farcaster_service
            .get_timeline(50)
            .await
            .map(|(casts, _)| casts)
        {
            Ok(casts) => {
                for cast in casts {
                    if !*running.read().await {
                        break;
                    }

                    if let Err(e) = process_mention(
                        &runtime,
                        &farcaster_service,
                        &cast,
                        &world_id,
                        fid,
                        dry_run,
                        &processed,
                    )
                    .await
                    {
                        warn!("Error processing mention: {}", e);
                    }
                }
            }
            Err(e) => {
                if e.to_string().contains("429") || e.to_string().to_lowercase().contains("rate") {
                    warn!("Rate limited. Backing off...");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                } else {
                    warn!("Farcaster API error: {}", e);
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            }
        }
    }

    // Cleanup
    farcaster_service.stop().await;
    runtime.stop().await?;

    info!("Shutdown complete");
    Ok(())
}
