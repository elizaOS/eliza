use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::client::{extract_webhook_headers, parse_webhook_payload, send_message, send_reaction, verify_signature};
use crate::config::NextcloudTalkConfig;
use crate::error::{NextcloudTalkError, Result};
use crate::types::{
    NextcloudTalkEventType, NextcloudTalkInboundMessage, NextcloudTalkRoom,
    NextcloudTalkWebhookPayload,
};

/// Callback invoked when the service emits a [`NextcloudTalkEventType`].
pub type EventCallback = Box<dyn Fn(NextcloudTalkEventType, serde_json::Value) + Send + Sync>;

/// Callback invoked when a message is received.
pub type MessageCallback =
    Box<dyn Fn(NextcloudTalkInboundMessage) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    message_callback: Option<MessageCallback>,
    known_rooms: HashMap<String, NextcloudTalkRoom>,
}

/// Native Nextcloud Talk webhook service.
pub struct NextcloudTalkService {
    config: NextcloudTalkConfig,
    state: Arc<RwLock<ServiceState>>,
}

impl NextcloudTalkService {
    /// Creates a new service from a validated [`NextcloudTalkConfig`].
    pub fn new(config: NextcloudTalkConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &NextcloudTalkConfig {
        &self.config
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Sets a callback invoked for each emitted event.
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(NextcloudTalkEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Sets a callback invoked for each received message.
    pub fn set_message_callback<F, Fut>(&mut self, callback: F)
    where
        F: Fn(NextcloudTalkInboundMessage) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.message_callback = Some(Box::new(move |msg| Box::pin(callback(msg))));
        }
    }

    /// Starts the Nextcloud Talk webhook server.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(NextcloudTalkError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        if !self.config.enabled {
            info!("Nextcloud Talk plugin is disabled via configuration");
            return Ok(());
        }

        info!("Starting Nextcloud Talk service...");

        let addr: SocketAddr = format!("{}:{}", self.config.webhook_host, self.config.webhook_port)
            .parse()
            .map_err(|e| NextcloudTalkError::ConfigError(format!("Invalid address: {}", e)))?;

        let state_clone = self.state.clone();
        let config_clone = self.config.clone();

        tokio::spawn(async move {
            if let Err(e) = run_webhook_server(addr, config_clone, state_clone).await {
                error!("Webhook server error: {}", e);
            }
        });

        {
            let mut state = self.state.write().await;
            state.is_running = true;
        }

        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    NextcloudTalkEventType::WorldConnected,
                    serde_json::json!({
                        "base_url": self.config.base_url,
                        "webhook_port": self.config.webhook_port,
                        "webhook_path": self.config.webhook_path
                    }),
                );
            }
        }

        info!(
            "Nextcloud Talk service started on {}:{}{} ",
            self.config.webhook_host, self.config.webhook_port, self.config.webhook_path
        );
        Ok(())
    }

    /// Stops the Nextcloud Talk service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Nextcloud Talk service...");

        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        info!("Nextcloud Talk service stopped");
        Ok(())
    }

    /// Sends a message to the given room.
    pub async fn send_message(&self, room_token: &str, text: &str) -> Result<String> {
        let result = send_message(
            &self.config.base_url,
            &self.config.bot_secret,
            room_token,
            text,
            None,
        )
        .await?;

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                NextcloudTalkEventType::MessageSent,
                serde_json::json!({
                    "room_token": room_token,
                    "message_id": result.message_id,
                    "text": text
                }),
            );
        }

        Ok(result.message_id)
    }

    /// Sends a reply to a message.
    pub async fn reply_to_message(
        &self,
        room_token: &str,
        message_id: &str,
        text: &str,
    ) -> Result<String> {
        let result = send_message(
            &self.config.base_url,
            &self.config.bot_secret,
            room_token,
            text,
            Some(message_id),
        )
        .await?;

        Ok(result.message_id)
    }

    /// Sends a reaction to a message.
    pub async fn send_reaction(
        &self,
        room_token: &str,
        message_id: &str,
        reaction: &str,
    ) -> Result<()> {
        send_reaction(
            &self.config.base_url,
            &self.config.bot_secret,
            room_token,
            message_id,
            reaction,
        )
        .await?;

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                NextcloudTalkEventType::ReactionSent,
                serde_json::json!({
                    "room_token": room_token,
                    "message_id": message_id,
                    "reaction": reaction
                }),
            );
        }

        Ok(())
    }

    /// Gets information about a known room.
    pub async fn get_room(&self, token: &str) -> Option<NextcloudTalkRoom> {
        let state = self.state.read().await;
        state.known_rooms.get(token).cloned()
    }
}

async fn run_webhook_server(
    addr: SocketAddr,
    config: NextcloudTalkConfig,
    state: Arc<RwLock<ServiceState>>,
) -> Result<()> {
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::Request;
    use hyper_util::rt::TokioIo;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind(addr).await?;
    info!("Webhook server listening on {}", addr);

    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let config = config.clone();
        let state = state.clone();

        tokio::spawn(async move {
            let service = service_fn(|req: Request<hyper::body::Incoming>| {
                let config = config.clone();
                let state = state.clone();
                async move { handle_request(req, config, state).await }
            });

            if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                debug!("Connection error: {}", e);
            }
        });
    }
}

async fn handle_request(
    req: hyper::Request<hyper::body::Incoming>,
    config: NextcloudTalkConfig,
    state: Arc<RwLock<ServiceState>>,
) -> std::result::Result<
    hyper::Response<http_body_util::Full<hyper::body::Bytes>>,
    std::convert::Infallible,
> {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper::{Method, StatusCode};

    let response = |status: StatusCode, body: &str| {
        hyper::Response::builder()
            .status(status)
            .body(Full::new(Bytes::from(body.to_string())))
            .unwrap()
    };

    // Only accept POST to webhook path
    if req.method() != Method::POST || req.uri().path() != config.webhook_path {
        return Ok(response(StatusCode::NOT_FOUND, "Not found"));
    }

    // Extract headers
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let webhook_headers = match extract_webhook_headers(&headers) {
        Some(h) => h,
        None => return Ok(response(StatusCode::BAD_REQUEST, "Missing required headers")),
    };

    // Read body
    let body_bytes = match req.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => return Ok(response(StatusCode::BAD_REQUEST, "Failed to read body")),
    };

    let body_str = match std::str::from_utf8(&body_bytes) {
        Ok(s) => s,
        Err(_) => return Ok(response(StatusCode::BAD_REQUEST, "Invalid UTF-8")),
    };

    // Verify signature
    if !verify_signature(
        &webhook_headers.signature,
        &webhook_headers.random,
        body_str,
        &config.bot_secret,
    ) {
        warn!("Invalid webhook signature");
        return Ok(response(StatusCode::UNAUTHORIZED, "Invalid signature"));
    }

    // Parse payload
    let payload: NextcloudTalkWebhookPayload = match serde_json::from_str(body_str) {
        Ok(p) => p,
        Err(e) => {
            warn!("Failed to parse webhook payload: {}", e);
            return Ok(response(StatusCode::BAD_REQUEST, "Invalid payload"));
        }
    };

    // Only handle "Create" events (new messages)
    if payload.event_type != "Create" {
        return Ok(response(StatusCode::OK, "OK"));
    }

    // Check room allowlist
    if !config.is_room_allowed(&payload.target.id) {
        debug!("Dropping message from non-allowed room: {}", payload.target.id);
        return Ok(response(StatusCode::OK, "OK"));
    }

    // Parse message
    let message = parse_webhook_payload(&payload);

    // Emit event and call message callback
    {
        let state_guard = state.read().await;

        if let Some(ref callback) = state_guard.event_callback {
            callback(
                NextcloudTalkEventType::MessageReceived,
                serde_json::to_value(&message).unwrap_or(serde_json::Value::Null),
            );
        }
    }

    // Call message callback (needs separate block to release read lock)
    {
        let state_guard = state.read().await;
        if let Some(ref callback) = state_guard.message_callback {
            let fut = callback(message);
            drop(state_guard);
            fut.await;
        }
    }

    Ok(response(StatusCode::OK, "OK"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_creation() {
        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        );
        let service = NextcloudTalkService::new(config);
        assert_eq!(service.config().base_url, "https://cloud.example.com");
    }

    #[tokio::test]
    async fn test_service_not_running_initially() {
        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        );
        let service = NextcloudTalkService::new(config);
        assert!(!service.is_running().await);
    }
}
