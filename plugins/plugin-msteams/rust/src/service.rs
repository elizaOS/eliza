//! MS Teams service implementation.

use crate::client::MSTeamsClient;
use crate::config::MSTeamsConfig;
use crate::error::{MSTeamsError, Result};
use crate::types::{
    ConversationType, MSTeamsConversation, MSTeamsConversationReference, MSTeamsEventType,
    MSTeamsMessagePayload, MSTeamsSendResult, MSTeamsUser,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};

use bytes::Bytes;
use http_body_util::Full;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{body::Incoming, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

/// Callback type for handling events.
pub type EventCallback = Box<dyn Fn(MSTeamsEventType, serde_json::Value) + Send + Sync>;

/// Internal service state.
#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
}

/// MS Teams service for elizaOS.
pub struct MSTeamsService {
    config: MSTeamsConfig,
    client: Arc<MSTeamsClient>,
    state: Arc<RwLock<ServiceState>>,
}

impl MSTeamsService {
    /// Creates a new service from configuration.
    pub fn new(config: MSTeamsConfig) -> Self {
        let client = Arc::new(MSTeamsClient::new(config.clone()));
        Self {
            config,
            client,
            state: Arc::new(RwLock::new(ServiceState::default())),
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &MSTeamsConfig {
        &self.config
    }

    /// Returns the underlying client.
    pub fn client(&self) -> Arc<MSTeamsClient> {
        Arc::clone(&self.client)
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Sets a callback invoked for each emitted event.
    pub async fn set_event_callback<F>(&self, callback: F)
    where
        F: Fn(MSTeamsEventType, serde_json::Value) + Send + Sync + 'static,
    {
        let mut state = self.state.write().await;
        state.event_callback = Some(Box::new(callback));
    }

    /// Starts the MS Teams webhook server.
    pub async fn start(&self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(MSTeamsError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        info!("Starting MS Teams service...");

        {
            let mut state = self.state.write().await;
            state.is_running = true;
        }

        // Emit connected event
        {
            let state = self.state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    MSTeamsEventType::WorldConnected,
                    serde_json::json!({
                        "app_id": self.config.app_id,
                        "tenant_id": self.config.tenant_id
                    }),
                );
            }
        }

        // Start webhook server
        let addr = SocketAddr::from(([0, 0, 0, 0], self.config.webhook_port));
        let listener = TcpListener::bind(addr).await.map_err(|e| {
            MSTeamsError::WebhookError(format!("Failed to bind to {}: {}", addr, e))
        })?;

        info!("MS Teams webhook server listening on {}", addr);

        let client = Arc::clone(&self.client);
        let state = Arc::clone(&self.state);
        let config = self.config.clone();
        let webhook_path = self.config.webhook_path.clone();

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let io = TokioIo::new(stream);
                        let client = Arc::clone(&client);
                        let state = Arc::clone(&state);
                        let config = config.clone();
                        let webhook_path = webhook_path.clone();

                        tokio::spawn(async move {
                            let service = service_fn(move |req| {
                                handle_request(
                                    req,
                                    Arc::clone(&client),
                                    Arc::clone(&state),
                                    config.clone(),
                                    webhook_path.clone(),
                                )
                            });

                            if let Err(e) = http1::Builder::new()
                                .serve_connection(io, service)
                                .await
                            {
                                error!("Error serving connection: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("Failed to accept connection: {}", e);
                    }
                }
            }
        });

        info!("MS Teams service started successfully");
        Ok(())
    }

    /// Stops the MS Teams service.
    pub async fn stop(&self) -> Result<()> {
        info!("Stopping MS Teams service...");

        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        info!("MS Teams service stopped");
        Ok(())
    }

    /// Send a proactive message.
    pub async fn send_message(
        &self,
        conversation_id: &str,
        text: &str,
    ) -> Result<MSTeamsSendResult> {
        self.client
            .send_proactive_message(conversation_id, text, None)
            .await
    }

    /// Send a poll.
    pub async fn send_poll(
        &self,
        conversation_id: &str,
        question: &str,
        options: &[String],
        max_selections: u32,
    ) -> Result<(MSTeamsSendResult, String)> {
        self.client
            .send_poll(conversation_id, question, options, max_selections)
            .await
    }

    /// Send an Adaptive Card.
    pub async fn send_adaptive_card(
        &self,
        conversation_id: &str,
        card: serde_json::Value,
        fallback_text: Option<&str>,
    ) -> Result<MSTeamsSendResult> {
        self.client
            .send_adaptive_card(conversation_id, card, fallback_text)
            .await
    }
}

/// Handle incoming HTTP requests.
async fn handle_request(
    req: Request<Incoming>,
    client: Arc<MSTeamsClient>,
    state: Arc<RwLock<ServiceState>>,
    config: MSTeamsConfig,
    webhook_path: String,
) -> std::result::Result<Response<Full<Bytes>>, hyper::Error> {
    let path = req.uri().path();
    let method = req.method();

    // Health check endpoint
    if path == "/health" && method == Method::GET {
        let body = serde_json::json!({
            "status": "ok",
            "service": "msteams"
        });
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/json")
            .body(Full::new(Bytes::from(body.to_string())))
            .unwrap());
    }

    // Webhook endpoint
    if path == webhook_path && method == Method::POST {
        // Read request body
        let body_bytes = match http_body_util::BodyExt::collect(req.into_body()).await {
            Ok(collected) => collected.to_bytes(),
            Err(e) => {
                error!("Failed to read request body: {}", e);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from("Bad request")))
                    .unwrap());
            }
        };

        // Parse activity
        let activity: serde_json::Value = match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(e) => {
                error!("Failed to parse activity: {}", e);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from("Invalid JSON")))
                    .unwrap());
            }
        };

        // Process activity
        if let Err(e) = process_activity(&activity, &client, &state, &config).await {
            error!("Failed to process activity: {}", e);
        }

        return Ok(Response::builder()
            .status(StatusCode::OK)
            .body(Full::new(Bytes::new()))
            .unwrap());
    }

    // 404 for other paths
    Ok(Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Full::new(Bytes::from("Not found")))
        .unwrap())
}

/// Process a Bot Framework activity.
async fn process_activity(
    activity: &serde_json::Value,
    client: &Arc<MSTeamsClient>,
    state: &Arc<RwLock<ServiceState>>,
    config: &MSTeamsConfig,
) -> Result<()> {
    let activity_type = activity.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // Extract conversation reference
    let conv_id = activity
        .get("conversation")
        .and_then(|c| c.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let conv_type_str = activity
        .get("conversation")
        .and_then(|c| c.get("conversationType"))
        .and_then(|v| v.as_str())
        .unwrap_or("personal");

    let conv_type = match conv_type_str {
        "groupChat" => ConversationType::GroupChat,
        "channel" => ConversationType::Channel,
        _ => ConversationType::Personal,
    };

    let tenant_id = activity
        .get("conversation")
        .and_then(|c| c.get("tenantId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let service_url = activity
        .get("serviceUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Validate tenant if configured
    if !config.allowed_tenants.is_empty() {
        if let Some(ref tid) = tenant_id {
            if !config.is_tenant_allowed(tid) {
                debug!("Ignoring activity from non-allowed tenant: {}", tid);
                return Ok(());
            }
        }
    }

    // Store conversation reference
    if !conv_id.is_empty() && service_url.is_some() {
        let from_user = activity.get("from").map(|f| MSTeamsUser {
            id: f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            name: f.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
            aad_object_id: f
                .get("aadObjectId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            email: None,
            user_principal_name: None,
        });

        let bot_user = activity.get("recipient").map(|r| MSTeamsUser {
            id: r.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            name: r.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
            aad_object_id: None,
            email: None,
            user_principal_name: None,
        });

        let conv_ref = MSTeamsConversationReference {
            activity_id: activity.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            user: from_user,
            bot: bot_user,
            conversation: MSTeamsConversation {
                id: conv_id.to_string(),
                conversation_type: Some(conv_type),
                tenant_id: tenant_id.clone(),
                name: activity
                    .get("conversation")
                    .and_then(|c| c.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                is_group: Some(conv_type != ConversationType::Personal),
            },
            channel_id: "msteams".to_string(),
            service_url,
            locale: activity.get("locale").and_then(|v| v.as_str()).map(|s| s.to_string()),
        };

        client.store_conversation_reference(conv_ref).await;
    }

    // Handle activity by type
    match activity_type {
        "message" => {
            let text = activity.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let cleaned_text = MSTeamsClient::strip_mention_tags(text);

            if cleaned_text.is_empty() {
                return Ok(());
            }

            let payload = MSTeamsMessagePayload {
                activity_id: activity.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                conversation_id: conv_id.to_string(),
                conversation_type: conv_type,
                from: MSTeamsUser {
                    id: activity
                        .get("from")
                        .and_then(|f| f.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: activity
                        .get("from")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    aad_object_id: None,
                    email: None,
                    user_principal_name: None,
                },
                conversation: MSTeamsConversation {
                    id: conv_id.to_string(),
                    conversation_type: Some(conv_type),
                    tenant_id,
                    name: None,
                    is_group: Some(conv_type != ConversationType::Personal),
                },
                service_url: activity
                    .get("serviceUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                text: Some(cleaned_text),
                timestamp: chrono::Utc::now().timestamp(),
                reply_to_id: activity
                    .get("replyToId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                channel_data: activity.get("channelData").cloned(),
            };

            let state = state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    MSTeamsEventType::MessageReceived,
                    serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
                );
            }
        }

        "conversationUpdate" => {
            // Handle members added/removed
            if let Some(members) = activity.get("membersAdded").and_then(|v| v.as_array()) {
                for member in members {
                    let state = state.read().await;
                    if let Some(ref callback) = state.event_callback {
                        callback(
                            MSTeamsEventType::EntityJoined,
                            serde_json::json!({
                                "user": member,
                                "conversationId": conv_id
                            }),
                        );
                    }
                }
            }

            if let Some(members) = activity.get("membersRemoved").and_then(|v| v.as_array()) {
                for member in members {
                    let state = state.read().await;
                    if let Some(ref callback) = state.event_callback {
                        callback(
                            MSTeamsEventType::EntityLeft,
                            serde_json::json!({
                                "user": member,
                                "conversationId": conv_id
                            }),
                        );
                    }
                }
            }
        }

        "messageReaction" => {
            let state = state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    MSTeamsEventType::ReactionReceived,
                    activity.clone(),
                );
            }
        }

        "invoke" => {
            // Handle card actions
            let state = state.read().await;
            if let Some(ref callback) = state.event_callback {
                callback(
                    MSTeamsEventType::CardActionReceived,
                    serde_json::json!({
                        "activityId": activity.get("id"),
                        "conversationId": conv_id,
                        "from": activity.get("from"),
                        "value": activity.get("value")
                    }),
                );
            }
        }

        _ => {
            debug!("Unhandled activity type: {}", activity_type);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_creation() {
        let config = MSTeamsConfig::new(
            "app-id".to_string(),
            "app-password".to_string(),
            "tenant-id".to_string(),
        );
        let service = MSTeamsService::new(config);
        assert_eq!(service.config().app_id, "app-id");
    }
}
