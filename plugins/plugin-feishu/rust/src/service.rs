use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::sync::RwLock;
use tracing::{debug, info};

use crate::config::FeishuConfig;
use crate::error::{FeishuError, Result};
use crate::types::{
    FeishuApiResponse, FeishuChatType, FeishuContent, FeishuEventType, FeishuMessagePayload,
    FeishuUser, TenantAccessToken, FeishuChat,
};

/// Feishu's maximum message length for text messages.
pub const MAX_MESSAGE_LENGTH: usize = 4000;

/// Callback invoked when the service emits a [`FeishuEventType`].
pub type EventCallback = Box<dyn Fn(FeishuEventType, serde_json::Value) + Send + Sync>;

struct TokenCache {
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    bot_open_id: Option<String>,
    token_cache: Option<TokenCache>,
}

/// Native Feishu API service.
pub struct FeishuService {
    config: FeishuConfig,
    state: Arc<RwLock<ServiceState>>,
    client: Client,
}

impl FeishuService {
    /// Creates a new service from a validated [`FeishuConfig`].
    pub fn new(config: FeishuConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            client,
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &FeishuConfig {
        &self.config
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Returns the bot's open ID once the service has started.
    pub async fn bot_open_id(&self) -> Option<String> {
        self.state.read().await.bot_open_id.clone()
    }

    /// Sets a callback invoked for each emitted event.
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(FeishuEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Gets or refreshes the tenant access token.
    async fn get_access_token(&self) -> Result<String> {
        // Check cache first
        {
            let state = self.state.read().await;
            if let Some(ref cache) = state.token_cache {
                if cache.expires_at > Instant::now() + Duration::from_secs(60) {
                    return Ok(cache.token.clone());
                }
            }
        }

        // Refresh token
        let url = format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            self.config.api_root()
        );

        let response = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret
            }))
            .send()
            .await?;

        let token_response: FeishuApiResponse<TenantAccessToken> = response.json().await?;

        if token_response.code != 0 {
            return Err(FeishuError::AuthenticationError(token_response.msg));
        }

        let data = token_response
            .data
            .ok_or_else(|| FeishuError::AuthenticationError("No token data".to_string()))?;

        // Cache the token
        let mut state = self.state.write().await;
        state.token_cache = Some(TokenCache {
            token: data.tenant_access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(data.expire as u64),
        });

        Ok(data.tenant_access_token)
    }

    /// Starts the Feishu service.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(FeishuError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        info!("Starting Feishu service...");

        // Get initial token to verify credentials
        let _token = self.get_access_token().await?;

        // Get bot info
        let bot_info = self.get_bot_info().await?;
        let bot_open_id = bot_info.open_id.clone();

        {
            let mut state = self.state.write().await;
            state.is_running = true;
            state.bot_open_id = Some(bot_open_id.clone());
        }

        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    FeishuEventType::WorldConnected,
                    serde_json::json!({
                        "bot_open_id": bot_open_id,
                        "bot_name": bot_info.name
                    }),
                );
            }
        }

        info!("Feishu service started successfully");
        Ok(())
    }

    /// Stops the Feishu service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Feishu service...");

        {
            let mut state = self.state.write().await;
            state.is_running = false;
            state.token_cache = None;
        }

        info!("Feishu service stopped");
        Ok(())
    }

    /// Gets bot information.
    async fn get_bot_info(&self) -> Result<FeishuUser> {
        let token = self.get_access_token().await?;
        let url = format!("{}/open-apis/bot/v3/info", self.config.api_root());

        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        #[derive(serde::Deserialize)]
        struct BotInfo {
            app_name: Option<String>,
            open_id: Option<String>,
        }

        let api_response: FeishuApiResponse<BotInfo> = response.json().await?;

        if api_response.code != 0 {
            return Err(FeishuError::ApiError(api_response.msg));
        }

        let data = api_response
            .data
            .ok_or_else(|| FeishuError::ApiError("No bot info data".to_string()))?;

        Ok(FeishuUser {
            open_id: data.open_id.unwrap_or_default(),
            union_id: None,
            user_id: None,
            name: data.app_name,
            avatar_url: None,
            is_bot: true,
        })
    }

    /// Sends a message to the given chat ID.
    pub async fn send_message(&self, chat_id: &str, content: &FeishuContent) -> Result<String> {
        let token = self.get_access_token().await?;
        let url = format!(
            "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
            self.config.api_root()
        );

        let (msg_type, msg_content) = if let Some(ref card) = content.card {
            ("interactive", card.to_string())
        } else if let Some(ref image_key) = content.image_key {
            ("image", serde_json::json!({ "image_key": image_key }).to_string())
        } else {
            let text = content.text.as_deref().unwrap_or("");
            ("text", serde_json::json!({ "text": text }).to_string())
        };

        let parts = if msg_type == "text" {
            split_message(content.text.as_deref().unwrap_or(""))
        } else {
            vec![msg_content]
        };

        let mut last_message_id = None;

        for part in parts {
            let body = serde_json::json!({
                "receive_id": chat_id,
                "msg_type": msg_type,
                "content": if msg_type == "text" {
                    serde_json::json!({ "text": part }).to_string()
                } else {
                    part
                }
            });

            let response = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .send()
                .await?;

            #[derive(serde::Deserialize)]
            struct MessageResponse {
                message_id: Option<String>,
            }

            let api_response: FeishuApiResponse<MessageResponse> = response.json().await?;

            if api_response.code != 0 {
                return Err(FeishuError::ApiError(api_response.msg));
            }

            if let Some(data) = api_response.data {
                last_message_id = data.message_id;
            }
        }

        last_message_id.ok_or_else(|| FeishuError::ApiError("No message ID returned".to_string()))
    }

    /// Replies to a message.
    pub async fn reply_to_message(
        &self,
        message_id: &str,
        content: &FeishuContent,
    ) -> Result<String> {
        let token = self.get_access_token().await?;
        let url = format!(
            "{}/open-apis/im/v1/messages/{}/reply",
            self.config.api_root(),
            message_id
        );

        let text = content.text.as_deref().unwrap_or("");
        let parts = split_message(text);

        let mut last_message_id = None;

        for part in parts {
            let body = serde_json::json!({
                "msg_type": "text",
                "content": serde_json::json!({ "text": part }).to_string()
            });

            let response = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .send()
                .await?;

            #[derive(serde::Deserialize)]
            struct MessageResponse {
                message_id: Option<String>,
            }

            let api_response: FeishuApiResponse<MessageResponse> = response.json().await?;

            if api_response.code != 0 {
                return Err(FeishuError::ApiError(api_response.msg));
            }

            if let Some(data) = api_response.data {
                last_message_id = data.message_id;
            }
        }

        last_message_id.ok_or_else(|| FeishuError::ApiError("No message ID returned".to_string()))
    }

    /// Fetches chat information by ID.
    pub async fn get_chat(&self, chat_id: &str) -> Result<FeishuChat> {
        let token = self.get_access_token().await?;
        let url = format!(
            "{}/open-apis/im/v1/chats/{}",
            self.config.api_root(),
            chat_id
        );

        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        #[derive(serde::Deserialize)]
        struct ChatInfo {
            chat_id: Option<String>,
            name: Option<String>,
            chat_mode: Option<String>,
            owner_id: Option<String>,
            description: Option<String>,
            tenant_key: Option<String>,
        }

        let api_response: FeishuApiResponse<ChatInfo> = response.json().await?;

        if api_response.code != 0 {
            return Err(FeishuError::ChatNotFound(api_response.msg));
        }

        let data = api_response
            .data
            .ok_or_else(|| FeishuError::ChatNotFound(chat_id.to_string()))?;

        Ok(FeishuChat {
            chat_id: data.chat_id.unwrap_or_else(|| chat_id.to_string()),
            chat_type: if data.chat_mode.as_deref() == Some("p2p") {
                FeishuChatType::P2p
            } else {
                FeishuChatType::Group
            },
            name: data.name,
            owner_open_id: data.owner_id,
            description: data.description,
            tenant_key: data.tenant_key,
        })
    }

    /// Handles an incoming message event (for use with webhooks/websockets).
    pub async fn handle_message_event(&self, payload: FeishuMessagePayload) {
        // Check if chat is allowed
        if !self.config.is_chat_allowed(&payload.chat.chat_id) {
            debug!(
                "Chat {} not authorized, skipping message",
                payload.chat.chat_id
            );
            return;
        }

        // Ignore bot messages if configured
        if let Some(ref sender) = payload.sender {
            if self.config.should_ignore_bot_messages && sender.is_bot {
                debug!("Ignoring bot message");
                return;
            }
        }

        // Emit event
        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                FeishuEventType::MessageReceived,
                serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            );
        }
    }
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
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        let service = FeishuService::new(config);
        assert_eq!(service.config().app_id, "cli_test123");
    }
}
