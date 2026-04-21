//! Telegram bot using elizaOS with full message pipeline.
//!
//! Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
//! Optional: POSTGRES_URL (defaults to PGLite)

use anyhow::{Context, Result};
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    services::IMessageService,
    types::primitives::string_to_uuid,
    Content, Memory,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use elizaos_plugin_sql::plugin as sql_plugin;
use elizaos_plugin_telegram::{TelegramConfig, TelegramEventType, TelegramService};
use std::sync::Arc;
use tokio::signal;
use tokio::sync::RwLock;
use tracing::{error, info};

const CHARACTER_JSON: &str = r#"{
    "name": "TelegramEliza",
    "bio": "A helpful AI assistant on Telegram.",
    "system": "You are TelegramEliza, a helpful AI assistant on Telegram. Be friendly, concise, and genuinely helpful. Keep responses short - suitable for mobile chat."
}"#;

struct State {
    runtime: AgentRuntime,
    name: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("elizaos=info,telegram_agent=info,teloxide=warn")
        .init();

    let _ = dotenvy::dotenv();

    std::env::var("TELEGRAM_BOT_TOKEN").context("Missing TELEGRAM_BOT_TOKEN")?;
    std::env::var("OPENAI_API_KEY").context("Missing OPENAI_API_KEY")?;

    info!("Starting TelegramEliza...");

    let character = parse_character(CHARACTER_JSON)?;
    let name = character.name.clone();

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        plugins: vec![sql_plugin(), create_openai_elizaos_plugin()?],
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    let state = Arc::new(State {
        runtime,
        name: name.clone(),
    });

    let telegram = Arc::new(RwLock::new(TelegramService::new(TelegramConfig::from_env()?)));

    let s = Arc::clone(&state);
    let t = Arc::clone(&telegram);
    telegram.write().await.set_event_callback(move |event, payload| {
        let state = Arc::clone(&s);
        let telegram = Arc::clone(&t);
        match event {
            TelegramEventType::MessageReceived => {
                tokio::spawn(async move {
                    if let Err(e) = process(&state, &telegram, payload).await {
                        error!("Error: {}", e);
                    }
                });
            }
            _ => {}
        }
    });

    telegram.write().await.start().await?;
    info!("{} is running. Press Ctrl+C to stop.", name);

    signal::ctrl_c().await?;
    telegram.write().await.stop().await?;
    state.runtime.stop().await?;
    Ok(())
}

async fn process(
    state: &State,
    telegram: &Arc<RwLock<TelegramService>>,
    payload: serde_json::Value,
) -> Result<()> {
    let text = payload
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return Ok(());
    }

    let chat_id = payload
        .get("chat")
        .and_then(|c| c.get("id"))
        .and_then(|id| id.as_i64())
        .context("Missing chat.id")?;

    let message_id = payload
        .get("message_id")
        .and_then(|id| id.as_i64())
        .context("Missing message_id")?;

    let thread_id = payload.get("thread_id").and_then(|id| id.as_i64());

    let user_id = payload
        .get("from_user")
        .and_then(|f| f.get("id"))
        .and_then(|id| id.as_i64())
        .unwrap_or(0);

    // Deterministic IDs (matches TS/Python `string_to_uuid` parity)
    let entity_id = string_to_uuid(format!("telegram-user-{}", user_id));
    let room_key = match thread_id {
        Some(tid) => format!("telegram-room-{}-{}", chat_id, tid),
        None => format!("telegram-room-{}", chat_id),
    };
    let room_id = string_to_uuid(room_key);

    // Handle Telegram `/start` without invoking the LLM.
    if text.starts_with("/start") {
        let from_user = payload.get("from_user");
        let first_name = from_user
            .and_then(|u| u.get("first_name"))
            .and_then(|n| n.as_str())
            .unwrap_or("friend");
        let greeting = format!("👋 Hey {first_name}! I'm {}. How can I help?", state.name);
        telegram.read().await.send_message(chat_id, &greeting).await?;
        return Ok(());
    }

    // Match chat/main.rs pattern: Content with text, Memory::new
    let content = Content {
        text: Some(text.to_string()),
        source: Some("telegram".to_string()),
        ..Default::default()
    };
    let mut message = Memory::new(entity_id, room_id, content);

    let result = state
        .runtime
        .message_service()
        .handle_message(&state.runtime, &mut message, None, None)
        .await?;

    if let Some(text) = result.response_content.and_then(|c| c.text) {
        let message_id_i32 = i32::try_from(message_id).unwrap_or(0);
        if message_id_i32 > 0 {
            telegram
                .read()
                .await
                .reply_to_message(chat_id, message_id_i32, &text)
                .await?;
        } else {
            telegram.read().await.send_message(chat_id, &text).await?;
        }
    }

    Ok(())
}
