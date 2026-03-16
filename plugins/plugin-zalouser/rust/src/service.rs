//! Zalo User service implementation.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::client::{
    check_zca_authenticated, check_zca_installed, get_zca_user_info, list_friends, list_groups,
    run_zca, send_image, send_link, send_message, ZcaRunOptions,
};
use crate::config::{ZaloUserConfig, MAX_MESSAGE_LENGTH};
use crate::error::{Result, ZaloUserError};
use crate::types::{
    SendMediaParams, SendMessageParams, SendMessageResult, ZaloChat, ZaloFriend, ZaloGroup,
    ZaloUser, ZaloUserEventType, ZaloUserInfo, ZaloUserProbe, ZaloUserQrCodePayload,
};

/// Callback for emitting events.
pub type EventCallback = Box<dyn Fn(ZaloUserEventType, serde_json::Value) + Send + Sync>;

/// Internal service state.
#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    current_user: Option<ZaloUserInfo>,
    #[allow(dead_code)]
    known_chats: HashMap<String, ZaloChat>,
}

/// Zalo User service for elizaOS.
pub struct ZaloUserService {
    config: ZaloUserConfig,
    state: Arc<RwLock<ServiceState>>,
    listener_handle: Option<tokio::task::JoinHandle<()>>,
}

impl ZaloUserService {
    /// Create a new service from configuration.
    pub fn new(config: ZaloUserConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            listener_handle: None,
        }
    }

    /// Get the service configuration.
    pub fn config(&self) -> &ZaloUserConfig {
        &self.config
    }

    /// Check if the service is running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Get the current authenticated user.
    pub async fn current_user(&self) -> Option<ZaloUserInfo> {
        self.state.read().await.current_user.clone()
    }

    /// Set the event callback.
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(ZaloUserEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Probe the Zalo connection for health checks.
    pub async fn probe(&self, _timeout_ms: u64) -> ZaloUserProbe {
        let start = std::time::Instant::now();

        // Check zca installed
        if !check_zca_installed().await {
            return ZaloUserProbe {
                ok: false,
                user: None,
                error: Some("zca-cli not found in PATH".to_string()),
                latency_ms: start.elapsed().as_millis() as u64,
            };
        }

        // Check authenticated
        let profile = self.config.default_profile.as_str();
        if !check_zca_authenticated(Some(profile)).await {
            return ZaloUserProbe {
                ok: false,
                user: None,
                error: Some("Not authenticated".to_string()),
                latency_ms: start.elapsed().as_millis() as u64,
            };
        }

        // Get user info
        match get_zca_user_info(Some(profile)).await {
            Some(info) => ZaloUserProbe {
                ok: true,
                user: Some(ZaloUser {
                    id: info.user_id.clone(),
                    display_name: info.display_name.clone(),
                    avatar: info.avatar.clone(),
                    username: None,
                    is_self: true,
                }),
                error: None,
                latency_ms: start.elapsed().as_millis() as u64,
            },
            None => ZaloUserProbe {
                ok: false,
                user: None,
                error: Some("Failed to get user info".to_string()),
                latency_ms: start.elapsed().as_millis() as u64,
            },
        }
    }

    /// Start the service.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(ZaloUserError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        info!("Starting Zalo User service...");

        // Check zca installed
        if !check_zca_installed().await {
            return Err(ZaloUserError::ZcaNotInstalled);
        }

        let profile = self.config.default_profile.as_str();

        // Check authenticated
        if !check_zca_authenticated(Some(profile)).await {
            return Err(ZaloUserError::NotAuthenticated);
        }

        // Get user info
        let user_info = get_zca_user_info(Some(profile)).await;
        if let Some(ref info) = user_info {
            info!("Zalo User connected: {} ({})", info.display_name, info.user_id);
        }

        {
            let mut state = self.state.write().await;
            state.current_user = user_info.clone();
            state.is_running = true;
        }

        // Emit started event
        self.emit_event(
            ZaloUserEventType::ClientStarted,
            serde_json::json!({
                "profile": profile,
                "user": user_info.as_ref().map(|u| {
                    serde_json::json!({
                        "id": u.user_id,
                        "displayName": u.display_name,
                        "avatar": u.avatar
                    })
                }),
                "running": true,
                "timestamp": chrono::Utc::now().timestamp_millis()
            }),
        )
        .await;

        // Start message listener
        // Note: In a full implementation, we'd start the listener here
        // For now, we skip it as it requires more complex async handling

        info!("Zalo User service started successfully");
        Ok(())
    }

    /// Stop the service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Zalo User service...");

        // Cancel listener if running
        if let Some(handle) = self.listener_handle.take() {
            handle.abort();
        }

        let user_info = {
            let mut state = self.state.write().await;
            state.is_running = false;
            state.current_user.clone()
        };

        // Emit stopped event
        self.emit_event(
            ZaloUserEventType::ClientStopped,
            serde_json::json!({
                "profile": self.config.default_profile,
                "user": user_info.as_ref().map(|u| {
                    serde_json::json!({
                        "id": u.user_id,
                        "displayName": u.display_name,
                        "avatar": u.avatar
                    })
                }),
                "running": false,
                "timestamp": chrono::Utc::now().timestamp_millis()
            }),
        )
        .await;

        info!("Zalo User service stopped");
        Ok(())
    }

    /// Send a text message.
    pub async fn send_message(&self, params: SendMessageParams) -> SendMessageResult {
        let profile = params
            .profile
            .as_deref()
            .unwrap_or(&self.config.default_profile);

        match send_message(&params.thread_id, &params.text, Some(profile), params.is_group).await {
            Ok(msg_id) => {
                self.emit_event(
                    ZaloUserEventType::MessageSent,
                    serde_json::json!({
                        "threadId": params.thread_id,
                        "messageId": msg_id
                    }),
                )
                .await;

                SendMessageResult {
                    success: true,
                    thread_id: params.thread_id,
                    message_id: msg_id,
                    error: None,
                }
            }
            Err(e) => SendMessageResult {
                success: false,
                thread_id: params.thread_id,
                message_id: None,
                error: Some(e.to_string()),
            },
        }
    }

    /// Send a media message.
    pub async fn send_media(&self, params: SendMediaParams) -> SendMessageResult {
        let profile = params
            .profile
            .as_deref()
            .unwrap_or(&self.config.default_profile);

        // Determine media type from URL
        let lower_url = params.media_url.to_lowercase();
        let result = if lower_url.ends_with(".mp4")
            || lower_url.ends_with(".mov")
            || lower_url.ends_with(".avi")
            || lower_url.ends_with(".webm")
        {
            // Video - use image command
            send_image(
                &params.thread_id,
                &params.media_url,
                params.caption.as_deref(),
                Some(profile),
                params.is_group,
            )
            .await
        } else if lower_url.ends_with(".jpg")
            || lower_url.ends_with(".jpeg")
            || lower_url.ends_with(".png")
            || lower_url.ends_with(".gif")
            || lower_url.ends_with(".webp")
        {
            send_image(
                &params.thread_id,
                &params.media_url,
                params.caption.as_deref(),
                Some(profile),
                params.is_group,
            )
            .await
        } else if lower_url.starts_with("http://") || lower_url.starts_with("https://") {
            send_link(&params.thread_id, &params.media_url, Some(profile), params.is_group).await
        } else {
            send_image(
                &params.thread_id,
                &params.media_url,
                params.caption.as_deref(),
                Some(profile),
                params.is_group,
            )
            .await
        };

        match result {
            Ok(msg_id) => {
                self.emit_event(
                    ZaloUserEventType::MessageSent,
                    serde_json::json!({
                        "threadId": params.thread_id,
                        "messageId": msg_id
                    }),
                )
                .await;

                SendMessageResult {
                    success: true,
                    thread_id: params.thread_id,
                    message_id: msg_id,
                    error: None,
                }
            }
            Err(e) => SendMessageResult {
                success: false,
                thread_id: params.thread_id,
                message_id: None,
                error: Some(e.to_string()),
            },
        }
    }

    /// List friends.
    pub async fn list_friends(&self, query: Option<&str>) -> Vec<ZaloFriend> {
        list_friends(Some(&self.config.default_profile), query).await
    }

    /// List groups.
    pub async fn list_groups(&self) -> Vec<ZaloGroup> {
        list_groups(Some(&self.config.default_profile)).await
    }

    /// Start QR code login.
    pub async fn start_qr_login(&self, profile: Option<&str>) -> ZaloUserQrCodePayload {
        let target_profile = profile.unwrap_or(&self.config.default_profile);

        let result = run_zca(
            &["auth", "login", "--qr-base64"],
            ZcaRunOptions {
                profile: Some(target_profile.to_string()),
                timeout_ms: Some(30000),
                ..Default::default()
            },
        )
        .await;

        if !result.ok {
            return ZaloUserQrCodePayload {
                qr_data_url: None,
                message: if result.stderr.is_empty() { "Failed to start QR login".to_string() } else { result.stderr.clone() },
                profile: Some(target_profile.to_string()),
            };
        }

        // Extract QR code data URL
        let qr_regex = regex::Regex::new(r"data:image/png;base64,[A-Za-z0-9+/=]+").unwrap();
        if let Some(qr_match) = qr_regex.find(&result.stdout) {
            let payload = ZaloUserQrCodePayload {
                qr_data_url: Some(qr_match.as_str().to_string()),
                message: "Scan QR code with Zalo app".to_string(),
                profile: Some(target_profile.to_string()),
            };

            self.emit_event(
                ZaloUserEventType::QrCodeReady,
                serde_json::to_value(&payload).unwrap_or_default(),
            )
            .await;

            return payload;
        }

        ZaloUserQrCodePayload {
            qr_data_url: None,
            message: if result.stdout.is_empty() { "QR login started".to_string() } else { result.stdout.clone() },
            profile: Some(target_profile.to_string()),
        }
    }

    /// Wait for login to complete.
    pub async fn wait_for_login(&self, profile: Option<&str>, timeout_ms: u64) -> (bool, String) {
        let target_profile = profile.unwrap_or(&self.config.default_profile);

        let result = run_zca(
            &["auth", "status"],
            ZcaRunOptions {
                profile: Some(target_profile.to_string()),
                timeout_ms: Some(timeout_ms),
                ..Default::default()
            },
        )
        .await;

        if result.ok {
            self.emit_event(
                ZaloUserEventType::LoginSuccess,
                serde_json::json!({
                    "profile": target_profile,
                    "timestamp": chrono::Utc::now().timestamp_millis()
                }),
            )
            .await;
            (true, "Login successful".to_string())
        } else {
            self.emit_event(
                ZaloUserEventType::LoginFailed,
                serde_json::json!({
                    "profile": target_profile,
                    "error": result.stderr,
                    "timestamp": chrono::Utc::now().timestamp_millis()
                }),
            )
            .await;
            (
                false,
                if result.stderr.is_empty() { "Login pending".to_string() } else { result.stderr.clone() },
            )
        }
    }

    /// Logout.
    pub async fn logout(&self, profile: Option<&str>) -> (bool, String) {
        let target_profile = profile.unwrap_or(&self.config.default_profile);

        let result = run_zca(
            &["auth", "logout"],
            ZcaRunOptions {
                profile: Some(target_profile.to_string()),
                timeout_ms: Some(10000),
                ..Default::default()
            },
        )
        .await;

        (
            result.ok,
            if result.ok {
                "Logged out".to_string()
            } else {
                if result.stderr.is_empty() { "Failed to logout".to_string() } else { result.stderr.clone() }
            },
        )
    }

    /// Emit an event.
    async fn emit_event(&self, event_type: ZaloUserEventType, payload: serde_json::Value) {
        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(event_type, payload);
        }
    }

    /// Split a message into chunks.
    pub fn split_message(text: &str, limit: usize) -> Vec<String> {
        let limit = if limit == 0 { MAX_MESSAGE_LENGTH } else { limit };

        if text.is_empty() || text.len() <= limit {
            return if text.is_empty() {
                Vec::new()
            } else {
                vec![text.to_string()]
            };
        }

        let mut chunks = Vec::new();
        let mut remaining = text;

        while remaining.len() > limit {
            let window = &remaining[..limit.min(remaining.len())];
            let last_newline = window.rfind('\n').unwrap_or(0);
            let last_space = window.rfind(' ').unwrap_or(0);
            let break_idx = if last_newline > 0 {
                last_newline
            } else if last_space > 0 {
                last_space
            } else {
                limit
            };

            let chunk = remaining[..break_idx].trim_end();
            if !chunk.is_empty() {
                chunks.push(chunk.to_string());
            }

            let next_start = (break_idx + 1).min(remaining.len());
            remaining = remaining[next_start..].trim_start();
        }

        if !remaining.is_empty() {
            chunks.push(remaining.to_string());
        }

        chunks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_message_short() {
        let chunks = ZaloUserService::split_message("Hello world", 2000);
        assert_eq!(chunks, vec!["Hello world"]);
    }

    #[test]
    fn test_split_message_empty() {
        let chunks = ZaloUserService::split_message("", 2000);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_split_message_long() {
        let text = "a".repeat(2500);
        let chunks = ZaloUserService::split_message(&text, 2000);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.len() <= 2000);
        }
    }
}
