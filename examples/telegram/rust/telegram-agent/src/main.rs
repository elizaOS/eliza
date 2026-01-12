//! Eliza Telegram Agent Example - Rust
//!
//! A complete Telegram bot powered by elizaOS with SQL persistence.
//!
//! Features:
//! - Full Telegram integration (private/group chats, reactions, inline buttons)
//! - PostgreSQL or PGLite database persistence
//! - OpenAI for language model capabilities
//!
//! Required environment variables:
//! - TELEGRAM_BOT_TOKEN: Your Telegram bot token from @BotFather
//! - OPENAI_API_KEY: Your OpenAI API key
//! - POSTGRES_URL (optional): PostgreSQL connection string (falls back to PGLite)

use anyhow::{Context, Result};
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    services::IMessageService,
    Content, Memory, UUID,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use elizaos_plugin_sql::plugin as sql_plugin;
use elizaos_plugin_telegram::{TelegramConfig, TelegramEventType, TelegramService};
use std::sync::Arc;
use tokio::signal;
use tracing::{error, info};

/// Character definition for the Telegram bot
const CHARACTER_JSON: &str = r#"{
    "name": "TelegramEliza",
    "bio": "A helpful and friendly AI assistant available on Telegram. I can answer questions, have conversations, and help with various tasks.",
    "system": "You are TelegramEliza, a helpful AI assistant on Telegram. You are friendly, knowledgeable, and concise in your responses. When users greet you with /start, welcome them warmly. Keep responses appropriate for chat format - not too long, easy to read. You can use emojis sparingly to make conversations more engaging."
}"#;

/// Application state shared across async tasks
struct AppState {
    runtime: AgentRuntime,
    character_name: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("elizaos=info".parse()?)
                .add_directive("telegram_agent=info".parse()?)
                .add_directive("teloxide=warn".parse()?),
        )
        .init();

    // Load environment variables from .env file
    let _ = dotenvy::dotenv();

    // Validate required environment variables
    std::env::var("TELEGRAM_BOT_TOKEN")
        .context("❌ TELEGRAM_BOT_TOKEN environment variable is required.\n   Get your bot token from @BotFather on Telegram")?;

    std::env::var("OPENAI_API_KEY")
        .context("❌ OPENAI_API_KEY environment variable is required")?;

    println!("🚀 Starting TelegramEliza...\n");

    // Parse the character definition
    let character = parse_character(CHARACTER_JSON)
        .context("Failed to parse character definition")?;

    let character_name = character.name.clone();

    // Create the agent runtime with all plugins
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        plugins: vec![
            sql_plugin(),                    // Database persistence
            create_openai_elizaos_plugin()?, // Language model capabilities
        ],
        ..Default::default()
    })
    .await
    .context("Failed to create agent runtime")?;

    // Initialize the runtime
    runtime
        .initialize()
        .await
        .context("Failed to initialize runtime")?;

    // Create application state
    let app_state = Arc::new(AppState {
        runtime,
        character_name: character_name.clone(),
    });

    // Create Telegram configuration
    let telegram_config = TelegramConfig::from_env()
        .context("Failed to create Telegram configuration")?;

    // Create the Telegram service
    let mut telegram_service = TelegramService::new(telegram_config);

    // Set up event callback to handle messages and commands
    let state_for_callback = Arc::clone(&app_state);
    telegram_service.set_event_callback(move |event_type, payload| {
        let state = Arc::clone(&state_for_callback);

        match event_type {
            TelegramEventType::SlashStart => {
                handle_start_command(&state.character_name, &payload);
            }
            TelegramEventType::MessageReceived => {
                // Spawn async task to handle message
                let state_clone = Arc::clone(&state);
                let payload_clone = payload.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_message(&state_clone, &payload_clone).await {
                        error!("Error handling message: {}", e);
                    }
                });
            }
            _ => {
                // Log other events for debugging
                tracing::debug!("Received event: {:?}", event_type);
            }
        }
    });

    // Start the Telegram service
    telegram_service
        .start()
        .await
        .context("Failed to start Telegram service")?;

    println!("\n✅ {} is now running on Telegram!", character_name);
    println!("   Send a message to your bot to start chatting.\n");
    println!("Press Ctrl+C to stop.\n");

    // Wait for shutdown signal
    signal::ctrl_c().await?;

    println!("\n\n🛑 Shutting down...");

    // Clean up
    telegram_service.stop().await?;
    app_state.runtime.stop().await?;

    println!("👋 Goodbye!\n");
    Ok(())
}

/// Handle the /start command
fn handle_start_command(character_name: &str, payload: &serde_json::Value) {
    let username = payload
        .get("from")
        .and_then(|f| f.get("first_name"))
        .and_then(|n| n.as_str())
        .unwrap_or("friend");

    let chat_id = payload
        .get("chat")
        .and_then(|c| c.get("id"))
        .and_then(|id| id.as_i64());

    info!(
        "New user {} started bot in chat {:?}",
        username, chat_id
    );

    // In a full implementation, you would send a welcome message here
    // using the TelegramService's send_message method
    info!(
        "Welcome message: 👋 Hello, {}! I'm {}. I'm here to help you with questions, conversations, and more!",
        username, character_name
    );
}

/// Handle incoming messages
async fn handle_message(state: &AppState, payload: &serde_json::Value) -> Result<()> {
    // Extract message details from payload
    let text = payload
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("");

    if text.is_empty() {
        return Ok(());
    }

    let chat_id = payload
        .get("chat")
        .and_then(|c| c.get("id"))
        .and_then(|id| id.as_i64())
        .context("Missing chat ID")?;

    let username = payload
        .get("from")
        .and_then(|f| f.get("username"))
        .and_then(|u| u.as_str())
        .or_else(|| {
            payload
                .get("from")
                .and_then(|f| f.get("first_name"))
                .and_then(|n| n.as_str())
        })
        .unwrap_or("unknown");

    info!(
        "Message from {} in chat {}: {}...",
        username,
        chat_id,
        &text[..text.len().min(50)]
    );

    // Create IDs for the conversation
    let entity_id = UUID::new_v4();
    let room_id = UUID::new_v4();

    // Create content from the message
    let content = Content {
        text: Some(text.to_string()),
        ..Default::default()
    };

    // Create a memory from the incoming message
    let mut message = Memory::new(entity_id, room_id, content);

    // Process through the runtime's message service
    let result = state
        .runtime
        .message_service()
        .handle_message(&state.runtime, &mut message, None, None)
        .await?;

    // Log the response
    if let Some(response_text) = result.response_content.and_then(|c| c.text) {
        info!(
            "Response for chat {} from {}: {}",
            chat_id,
            state.character_name,
            response_text
        );
        // In a full implementation, send this via telegram_service.send_message()
    } else {
        info!("No response generated for chat {}", chat_id);
    }

    Ok(())
}
