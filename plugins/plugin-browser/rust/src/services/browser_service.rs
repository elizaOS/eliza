use crate::services::BrowserWebSocketClient;
use crate::types::{BrowserConfig, BrowserSession};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use uuid::Uuid;

pub struct BrowserService {
    sessions: Arc<RwLock<HashMap<String, BrowserSession>>>,
    current_session_id: Arc<RwLock<Option<String>>>,
    client: Arc<BrowserWebSocketClient>,
    initialized: Arc<RwLock<bool>>,
}

impl BrowserService {
    pub fn new(config: BrowserConfig) -> Self {
        let server_url = format!("ws://localhost:{}", config.server_port);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            current_session_id: Arc::new(RwLock::new(None)),
            client: Arc::new(BrowserWebSocketClient::new(&server_url)),
            initialized: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        info!("Starting browser automation service");

        info!("Connecting to browser server...");
        self.client.connect().await?;

        self.wait_for_ready(60, 3000).await?;

        *self.initialized.write().await = true;
        info!("Browser service initialized successfully");

        Ok(())
    }

    pub async fn stop(&self) {
        info!("Stopping browser automation service");

        let session_ids: Vec<String> = self.sessions.read().await.keys().cloned().collect();
        for session_id in session_ids {
            if let Err(e) = self.destroy_session(&session_id).await {
                warn!("Failed to destroy session {}: {}", session_id, e);
            }
        }

        self.client.disconnect().await;
        *self.initialized.write().await = false;
    }

    pub async fn create_session(&self, session_id: &str) -> Result<BrowserSession, String> {
        if !*self.initialized.read().await {
            return Err("Browser service not initialized".to_string());
        }

        let response = self
            .client
            .send_message("createSession", HashMap::new())
            .await?;

        let server_session_id = response
            .data
            .as_ref()
            .and_then(|d| d.get("sessionId"))
            .and_then(|v| v.as_str())
            .ok_or("Failed to create session on server")?
            .to_string();

        let session = BrowserSession::new(server_session_id);
        self.sessions
            .write()
            .await
            .insert(session_id.to_string(), session.clone());
        *self.current_session_id.write().await = Some(session_id.to_string());

        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<BrowserSession> {
        self.sessions.read().await.get(session_id).cloned()
    }

    pub async fn get_current_session(&self) -> Option<BrowserSession> {
        let current_id = self.current_session_id.read().await.clone()?;
        self.sessions.read().await.get(&current_id).cloned()
    }

    pub async fn get_or_create_session(&self) -> Result<BrowserSession, String> {
        if let Some(session) = self.get_current_session().await {
            return Ok(session);
        }

        let session_id = format!(
            "session-{}-{}",
            Utc::now().timestamp_millis(),
            Uuid::new_v4()
        );
        self.create_session(&session_id).await
    }

    pub async fn destroy_session(&self, session_id: &str) -> Result<(), String> {
        let session = match self.sessions.read().await.get(session_id).cloned() {
            Some(s) => s,
            None => return Ok(()),
        };

        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session.id));

        self.client.send_message("destroySession", data).await?;

        self.sessions.write().await.remove(session_id);

        let mut current = self.current_session_id.write().await;
        if current.as_deref() == Some(session_id) {
            *current = None;
        }

        Ok(())
    }

    pub fn get_client(&self) -> Arc<BrowserWebSocketClient> {
        Arc::clone(&self.client)
    }

    pub async fn is_initialized(&self) -> bool {
        *self.initialized.read().await
    }

    async fn wait_for_ready(&self, max_attempts: u32, delay_ms: u64) -> Result<(), String> {
        info!("Waiting for browser server to be ready...");

        for attempt in 1..=max_attempts {
            match self.client.health().await {
                Ok(true) => {
                    info!("Browser server is ready");
                    return Ok(());
                }
                Ok(false) => {
                    debug!(
                        "Health check attempt {}/{} returned false",
                        attempt, max_attempts
                    );
                }
                Err(e) => {
                    debug!(
                        "Health check attempt {}/{} failed: {}",
                        attempt, max_attempts, e
                    );
                }
            }

            if attempt < max_attempts {
                info!(
                    "Server not ready yet, retrying in {}ms... (attempt {}/{})",
                    delay_ms, attempt, max_attempts
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }

        Err(format!(
            "Browser server did not become ready after {} attempts",
            max_attempts
        ))
    }
}
