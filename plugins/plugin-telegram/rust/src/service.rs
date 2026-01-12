use std::sync::Arc;
use teloxide::prelude::*;
use teloxide::types::{ChatId, MessageId, ReplyParameters};
use tokio::sync::RwLock;
use tracing::{debug, info};

use crate::config::TelegramConfig;
use crate::error::{Result, TelegramError};
use crate::types::{
    TelegramChannelType, TelegramChat, TelegramEventType, TelegramMessagePayload, TelegramUser,
};

/// Telegram's maximum message length for `sendMessage` (nominally 4096 characters).
///
/// Note: this crate currently uses Rust `&str` byte length as an approximation when splitting.
pub const MAX_MESSAGE_LENGTH: usize = 4096;

/// Callback invoked when the service emits a [`TelegramEventType`].
pub type EventCallback = Box<dyn Fn(TelegramEventType, serde_json::Value) + Send + Sync>;

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    bot_username: Option<String>,
}

/// Native Telegram Bot API service (powered by `teloxide`).
pub struct TelegramService {
    config: TelegramConfig,
    state: Arc<RwLock<ServiceState>>,
    bot: Option<Bot>,
}

impl TelegramService {
    /// Creates a new service from a validated [`TelegramConfig`].
    pub fn new(config: TelegramConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            bot: None,
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &TelegramConfig {
        &self.config
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Returns the bot's username (without `@`) once the service has started.
    pub async fn bot_username(&self) -> Option<String> {
        self.state.read().await.bot_username.clone()
    }

    /// Sets a callback invoked for each emitted event.
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(TelegramEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Starts the Telegram service and begins receiving updates.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(TelegramError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        info!("Starting Telegram service...");

        let bot = Bot::new(&self.config.bot_token);

        let me = bot
            .get_me()
            .await
            .map_err(|e| TelegramError::ConnectionFailed(e.to_string()))?;

        let bot_username = me.username.clone();

        self.bot = Some(bot.clone());

        {
            let mut state = self.state.write().await;
            state.is_running = true;
            state.bot_username = bot_username.clone();
        }

        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    TelegramEventType::WorldConnected,
                    serde_json::json!({
                        "bot_id": me.id.0,
                        "bot_username": bot_username,
                        "bot_name": me.first_name
                    }),
                );
            }
        }

        let state_clone = self.state.clone();
        let config_clone = self.config.clone();
        let bot_clone = bot.clone();

        tokio::spawn(async move {
            let handler = Update::filter_message().endpoint(
                |bot: Bot,
                 msg: Message,
                 state: Arc<RwLock<ServiceState>>,
                 config: TelegramConfig| async move {
                    handle_message(bot, msg, state, config).await
                },
            );

            Dispatcher::builder(bot_clone, handler)
                .dependencies(dptree::deps![state_clone, config_clone])
                .enable_ctrlc_handler()
                .build()
                .dispatch()
                .await;
        });

        info!("Telegram service started successfully");
        Ok(())
    }

    /// Stops the Telegram service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Telegram service...");

        self.bot = None;

        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        info!("Telegram service stopped");
        Ok(())
    }

    /// Sends a message to the given chat ID.
    ///
    /// If `text` exceeds [`MAX_MESSAGE_LENGTH`], it is split and sent as multiple messages.
    pub async fn send_message(&self, chat_id: i64, text: &str) -> Result<i32> {
        let bot = self
            .bot
            .as_ref()
            .ok_or(TelegramError::ClientNotInitialized)?;

        let parts = split_message(text);

        let mut last_message_id = None;
        for part in parts {
            let msg = bot
                .send_message(ChatId(chat_id), &part)
                .await
                .map_err(|e| TelegramError::ApiError(e.to_string()))?;
            last_message_id = Some(msg.id.0);
        }

        last_message_id.ok_or_else(|| {
            TelegramError::InvalidArgument("No message content provided".to_string())
        })
    }

    /// Replies to a message in the given chat.
    ///
    /// If the reply text exceeds [`MAX_MESSAGE_LENGTH`], it is split into multiple messages.
    pub async fn reply_to_message(&self, chat_id: i64, message_id: i32, text: &str) -> Result<i32> {
        let bot = self
            .bot
            .as_ref()
            .ok_or(TelegramError::ClientNotInitialized)?;

        let parts = split_message(text);

        let mut last_message_id = None;
        for (i, part) in parts.iter().enumerate() {
            let msg = if i == 0 {
                bot.send_message(ChatId(chat_id), part)
                    .reply_parameters(ReplyParameters::new(MessageId(message_id)))
                    .await
                    .map_err(|e| TelegramError::ApiError(e.to_string()))?
            } else {
                bot.send_message(ChatId(chat_id), part)
                    .await
                    .map_err(|e| TelegramError::ApiError(e.to_string()))?
            };
            last_message_id = Some(msg.id.0);
        }

        last_message_id.ok_or_else(|| {
            TelegramError::InvalidArgument("No message content provided".to_string())
        })
    }

    /// Edits an existing message's text.
    pub async fn edit_message(&self, chat_id: i64, message_id: i32, text: &str) -> Result<()> {
        let bot = self
            .bot
            .as_ref()
            .ok_or(TelegramError::ClientNotInitialized)?;

        bot.edit_message_text(ChatId(chat_id), MessageId(message_id), text)
            .await
            .map_err(|e| TelegramError::ApiError(e.to_string()))?;

        Ok(())
    }

    /// Deletes a message from a chat.
    pub async fn delete_message(&self, chat_id: i64, message_id: i32) -> Result<()> {
        let bot = self
            .bot
            .as_ref()
            .ok_or(TelegramError::ClientNotInitialized)?;

        bot.delete_message(ChatId(chat_id), MessageId(message_id))
            .await
            .map_err(|e| TelegramError::ApiError(e.to_string()))?;

        Ok(())
    }

    /// Fetches basic chat information by ID.
    pub async fn get_chat(&self, chat_id: i64) -> Result<TelegramChat> {
        let bot = self
            .bot
            .as_ref()
            .ok_or(TelegramError::ClientNotInitialized)?;

        let chat = bot
            .get_chat(ChatId(chat_id))
            .await
            .map_err(|e| TelegramError::ChatNotFound(e.to_string()))?;

        Ok(TelegramChat {
            id: chat.id.0,
            chat_type: match chat.kind {
                teloxide::types::ChatKind::Private(_) => TelegramChannelType::Private,
                teloxide::types::ChatKind::Public(ref p) => match p.kind {
                    teloxide::types::PublicChatKind::Group(_) => TelegramChannelType::Group,
                    teloxide::types::PublicChatKind::Supergroup(_) => {
                        TelegramChannelType::Supergroup
                    }
                    teloxide::types::PublicChatKind::Channel(_) => TelegramChannelType::Channel,
                },
            },
            title: chat.title().map(|s| s.to_string()),
            username: chat.username().map(|s| s.to_string()),
            first_name: chat.first_name().map(|s| s.to_string()),
            is_forum: false,
        })
    }
}

async fn handle_message(
    _bot: Bot,
    msg: Message,
    state: Arc<RwLock<ServiceState>>,
    config: TelegramConfig,
) -> ResponseResult<()> {
    let from_user = msg.from.as_ref().map(|u| TelegramUser {
        id: u.id.0 as i64,
        username: u.username.clone(),
        first_name: Some(u.first_name.clone()),
        last_name: u.last_name.clone(),
        is_bot: u.is_bot,
    });

    if let Some(ref user) = from_user {
        if user.is_bot && config.should_ignore_bot_messages {
            debug!("Ignoring bot message from {:?}", user.username);
            return Ok(());
        }
    }

    if !config.is_chat_allowed(msg.chat.id.0) {
        debug!("Ignoring message from non-allowed chat {}", msg.chat.id.0);
        return Ok(());
    }

    let chat = TelegramChat {
        id: msg.chat.id.0,
        chat_type: match msg.chat.kind {
            teloxide::types::ChatKind::Private(_) => TelegramChannelType::Private,
            teloxide::types::ChatKind::Public(ref p) => match p.kind {
                teloxide::types::PublicChatKind::Group(_) => TelegramChannelType::Group,
                teloxide::types::PublicChatKind::Supergroup(_) => TelegramChannelType::Supergroup,
                teloxide::types::PublicChatKind::Channel(_) => TelegramChannelType::Channel,
            },
        },
        title: msg.chat.title().map(|s| s.to_string()),
        username: msg.chat.username().map(|s| s.to_string()),
        first_name: msg.chat.first_name().map(|s| s.to_string()),
        is_forum: false,
    };

    let payload = TelegramMessagePayload {
        message_id: msg.id.0 as i64,
        chat,
        from_user,
        text: msg.text().map(|s| s.to_string()),
        date: msg.date.timestamp(),
        thread_id: msg.thread_id.map(|t| i64::from(t.0 .0)),
    };

    let state = state.read().await;
    if let Some(ref callback) = state.event_callback {
        callback(
            TelegramEventType::MessageReceived,
            serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
        );
    }

    Ok(())
}

/// Splits a message into chunks that are each at most [`MAX_MESSAGE_LENGTH`] bytes.
pub fn split_message(content: &str) -> Vec<String> {
    if content.len() <= MAX_MESSAGE_LENGTH {
        return vec![content.to_string()];
    }

    let mut parts = Vec::new();
    let mut current = String::new();

    for line in content.lines() {
        let line_with_newline = if current.is_empty() {
            line.to_string()
        } else {
            format!("\n{}", line)
        };

        if current.len() + line_with_newline.len() > MAX_MESSAGE_LENGTH {
            if !current.is_empty() {
                parts.push(current);
                current = String::new();
            }

            if line.len() > MAX_MESSAGE_LENGTH {
                let words: Vec<&str> = line.split_whitespace().collect();
                for word in words {
                    let word_with_space = if current.is_empty() {
                        word.to_string()
                    } else {
                        format!(" {}", word)
                    };

                    if current.len() + word_with_space.len() > MAX_MESSAGE_LENGTH {
                        if !current.is_empty() {
                            parts.push(current);
                            current = String::new();
                        }

                        if word.len() > MAX_MESSAGE_LENGTH {
                            let chars: Vec<char> = word.chars().collect();
                            for chunk in chars.chunks(MAX_MESSAGE_LENGTH) {
                                parts.push(chunk.iter().collect());
                            }
                        } else {
                            current = word.to_string();
                        }
                    } else {
                        current.push_str(&word_with_space);
                    }
                }
            } else {
                current = line.to_string();
            }
        } else {
            current.push_str(&line_with_newline);
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_message_short() {
        let msg = "Hello, world!";
        let parts = split_message(msg);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], msg);
    }

    #[test]
    fn test_split_message_long() {
        let msg = "a".repeat(MAX_MESSAGE_LENGTH + 500);
        let parts = split_message(&msg);
        assert!(parts.len() > 1);
        for part in &parts {
            assert!(part.len() <= MAX_MESSAGE_LENGTH);
        }
    }

    #[test]
    fn test_service_creation() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string());
        let service = TelegramService::new(config);
        assert_eq!(service.config().bot_token, "123456:ABC-DEF");
    }
}
