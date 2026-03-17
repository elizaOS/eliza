//! Native Zalo OA service implementation.

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info};

use crate::client::{ZaloClient, MAX_MESSAGE_LENGTH};
use crate::config::ZaloConfig;
use crate::error::{Result, ZaloError};
use crate::types::{
    ZaloBotProbe, ZaloBotStatusPayload, ZaloEventType, ZaloOAInfo, ZaloSendImageParams,
    ZaloSendMessageParams,
};

/// Callback invoked when the service emits a [`ZaloEventType`].
pub type EventCallback = Box<dyn Fn(ZaloEventType, serde_json::Value) + Send + Sync>;

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    oa_info: Option<ZaloOAInfo>,
}

/// Native Zalo OA API service.
pub struct ZaloService {
    config: ZaloConfig,
    state: Arc<RwLock<ServiceState>>,
    client: Option<ZaloClient>,
}

impl ZaloService {
    /// Creates a new service from a validated [`ZaloConfig`].
    pub fn new(config: ZaloConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            client: None,
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &ZaloConfig {
        &self.config
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Returns the OA info once the service has started.
    pub async fn oa_info(&self) -> Option<ZaloOAInfo> {
        self.state.read().await.oa_info.clone()
    }

    /// Sets a callback invoked for each emitted event.
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(ZaloEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Starts the Zalo service.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(ZaloError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        info!("Starting Zalo service...");

        // Create client
        let client = if let Some(ref proxy_url) = self.config.proxy_url {
            ZaloClient::with_proxy(self.config.access_token.clone(), proxy_url)?
        } else {
            ZaloClient::new(self.config.access_token.clone())
        };

        // Get OA info
        let oa_info = match client.get_oa_info().await {
            Ok(info) => {
                info!("Connected to Zalo OA: {} (ID: {})", info.name, info.oa_id);
                Some(info)
            }
            Err(e) => {
                debug!("Failed to get OA info: {}", e);
                None
            }
        };

        self.client = Some(client);

        {
            let mut state = self.state.write().await;
            state.is_running = true;
            state.oa_info = oa_info.clone();
        }

        // Emit bot started event
        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                let payload = ZaloBotStatusPayload {
                    oa_id: oa_info.as_ref().map(|i| i.oa_id.clone()),
                    oa_name: oa_info.as_ref().map(|i| i.name.clone()),
                    update_mode: self.config.update_mode().to_string(),
                    timestamp: chrono::Utc::now().timestamp_millis(),
                };
                callback(
                    ZaloEventType::BotStarted,
                    serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
                );
            }
        }

        info!("Zalo service started successfully");
        Ok(())
    }

    /// Stops the Zalo service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Zalo service...");

        // Emit bot stopped event
        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                let payload = ZaloBotStatusPayload {
                    oa_id: state.oa_info.as_ref().map(|i| i.oa_id.clone()),
                    oa_name: state.oa_info.as_ref().map(|i| i.name.clone()),
                    update_mode: self.config.update_mode().to_string(),
                    timestamp: chrono::Utc::now().timestamp_millis(),
                };
                callback(
                    ZaloEventType::BotStopped,
                    serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
                );
            }
        }

        self.client = None;

        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        info!("Zalo service stopped");
        Ok(())
    }

    /// Sends a text message to a user.
    pub async fn send_message(&self, user_id: &str, text: &str) -> Result<String> {
        let client = self
            .client
            .as_ref()
            .ok_or(ZaloError::ClientNotInitialized)?;

        let params = ZaloSendMessageParams {
            user_id: user_id.to_string(),
            text: text.chars().take(MAX_MESSAGE_LENGTH).collect(),
        };

        let message_id = client.send_message(&params).await?;

        // Emit message sent event
        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    ZaloEventType::MessageSent,
                    serde_json::json!({
                        "user_id": user_id,
                        "message_id": message_id,
                        "text": text,
                        "success": true
                    }),
                );
            }
        }

        Ok(message_id)
    }

    /// Sends an image message to a user.
    pub async fn send_image(
        &self,
        user_id: &str,
        image_url: &str,
        caption: Option<&str>,
    ) -> Result<String> {
        let client = self
            .client
            .as_ref()
            .ok_or(ZaloError::ClientNotInitialized)?;

        let params = ZaloSendImageParams {
            user_id: user_id.to_string(),
            image_url: image_url.to_string(),
            caption: caption.map(|s| s.to_string()),
        };

        client.send_image(&params).await
    }

    /// Probes the Zalo OA connection for health checks.
    pub async fn probe_zalo(&self, timeout_ms: u64) -> ZaloBotProbe {
        let client = match self.client.as_ref() {
            Some(c) => c,
            None => {
                return ZaloBotProbe {
                    ok: false,
                    oa: None,
                    error: Some("Client not initialized".to_string()),
                    latency_ms: 0,
                };
            }
        };

        let start = std::time::Instant::now();

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            client.get_oa_info(),
        )
        .await;

        let latency_ms = start.elapsed().as_millis() as u64;

        match result {
            Ok(Ok(oa_info)) => ZaloBotProbe {
                ok: true,
                oa: Some(oa_info),
                error: None,
                latency_ms,
            },
            Ok(Err(e)) => ZaloBotProbe {
                ok: false,
                oa: None,
                error: Some(e.to_string()),
                latency_ms,
            },
            Err(_) => ZaloBotProbe {
                ok: false,
                oa: None,
                error: Some("Timeout".to_string()),
                latency_ms,
            },
        }
    }

    /// Refreshes the access token.
    pub async fn refresh_token(&mut self) -> Result<()> {
        let refresh_token = self
            .config
            .refresh_token
            .as_ref()
            .ok_or_else(|| ZaloError::TokenRefreshFailed("No refresh token configured".to_string()))?;

        let response = ZaloClient::refresh_token(
            &self.config.app_id,
            &self.config.secret_key,
            refresh_token,
        )
        .await?;

        // Update config and client
        self.config.access_token = response.access_token.clone();
        self.config.refresh_token = Some(response.refresh_token);

        if let Some(ref mut client) = self.client {
            client.set_access_token(response.access_token);
        }

        // Emit token refreshed event
        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    ZaloEventType::TokenRefreshed,
                    serde_json::json!({
                        "expires_in": response.expires_in,
                        "timestamp": chrono::Utc::now().timestamp_millis()
                    }),
                );
            }
        }

        info!("Access token refreshed successfully");
        Ok(())
    }
}

/// Splits a message into chunks that fit within the max message length.
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
                // Split long lines by words; split words that exceed limit by character
                let words: Vec<&str> = line.split_whitespace().collect();
                for word in words {
                    if word.len() > MAX_MESSAGE_LENGTH {
                        // Single word exceeds limit: flush current, then chunk by character
                        if !current.is_empty() {
                            parts.push(current);
                            current = String::new();
                        }
                        let chars: Vec<char> = word.chars().collect();
                        for chunk in chars.chunks(MAX_MESSAGE_LENGTH) {
                            parts.push(chunk.iter().collect());
                        }
                        continue;
                    }
                    let word_with_space = if current.is_empty() {
                        word.to_string()
                    } else {
                        format!(" {}", word)
                    };

                    if current.len() + word_with_space.len() > MAX_MESSAGE_LENGTH {
                        if !current.is_empty() {
                            parts.push(current);
                        }
                        current = word.to_string();
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
        let config = ZaloConfig::new(
            "app_id".to_string(),
            "secret_key".to_string(),
            "access_token".to_string(),
        );
        let service = ZaloService::new(config);
        assert_eq!(service.config().app_id, "app_id");
    }
}
