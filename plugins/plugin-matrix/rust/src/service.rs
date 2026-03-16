//! Matrix service implementation for elizaOS.

use crate::types::*;
use reqwest::Client;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// Matrix messaging service for elizaOS agents.
pub struct MatrixService {
    settings: MatrixSettings,
    client: Client,
    connected: Arc<RwLock<bool>>,
    syncing: Arc<RwLock<bool>>,
    next_batch: Arc<RwLock<Option<String>>>,
    rooms: Arc<RwLock<HashMap<String, MatrixRoom>>>,
}

impl MatrixService {
    /// Create a new Matrix service instance.
    pub async fn new(settings: MatrixSettings) -> Result<Self, MatrixError> {
        let service = Self {
            settings,
            client: Client::new(),
            connected: Arc::new(RwLock::new(false)),
            syncing: Arc::new(RwLock::new(false)),
            next_batch: Arc::new(RwLock::new(None)),
            rooms: Arc::new(RwLock::new(HashMap::new())),
        };

        service.validate_settings()?;
        Ok(service)
    }

    fn validate_settings(&self) -> Result<(), MatrixError> {
        if self.settings.homeserver.is_empty() {
            return Err(MatrixError::config_with_setting(
                "MATRIX_HOMESERVER is required",
                "MATRIX_HOMESERVER",
            ));
        }

        if self.settings.user_id.is_empty() {
            return Err(MatrixError::config_with_setting(
                "MATRIX_USER_ID is required",
                "MATRIX_USER_ID",
            ));
        }

        if self.settings.access_token.is_empty() {
            return Err(MatrixError::config_with_setting(
                "MATRIX_ACCESS_TOKEN is required",
                "MATRIX_ACCESS_TOKEN",
            ));
        }

        Ok(())
    }

    /// Start the Matrix service.
    pub async fn start(&self) -> Result<(), MatrixError> {
        // Perform initial sync
        self.sync(None).await?;
        *self.connected.write().await = true;
        info!(
            "Matrix service started for {} on {}",
            self.settings.user_id, self.settings.homeserver
        );

        // Join configured rooms
        for room in &self.settings.rooms {
            match self.join_room(room).await {
                Ok(room_id) => info!("Joined room {}", room_id),
                Err(e) => warn!("Failed to join room {}: {}", room, e),
            }
        }

        Ok(())
    }

    /// Stop the Matrix service.
    pub async fn stop(&self) {
        *self.connected.write().await = false;
        info!("Matrix service stopped");
    }

    /// Check if connected to Matrix.
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Get the user ID.
    pub fn get_user_id(&self) -> &str {
        &self.settings.user_id
    }

    /// Get the homeserver URL.
    pub fn get_homeserver(&self) -> &str {
        &self.settings.homeserver
    }

    /// Get the settings.
    pub fn get_settings(&self) -> &MatrixSettings {
        &self.settings
    }

    /// Build a Matrix API URL.
    fn api_url(&self, path: &str) -> String {
        let base = self.settings.homeserver.trim_end_matches('/');
        format!("{}/_matrix/client/v3{}", base, path)
    }

    /// Perform a sync operation.
    async fn sync(&self, since: Option<&str>) -> Result<SyncResponse, MatrixError> {
        let mut url = self.api_url("/sync?timeout=30000");
        if let Some(token) = since {
            url.push_str(&format!("&since={}", token));
        }

        let response: SyncResponse = self
            .client
            .get(&url)
            .bearer_auth(&self.settings.access_token)
            .send()
            .await?
            .json()
            .await?;

        *self.next_batch.write().await = Some(response.next_batch.clone());

        if !*self.syncing.read().await {
            *self.syncing.write().await = true;
            info!("Matrix sync complete");
        }

        // Update room cache
        if let Some(rooms) = &response.rooms {
            if let Some(joined) = &rooms.join {
                let mut room_cache = self.rooms.write().await;
                for (room_id, _room) in joined {
                    if !room_cache.contains_key(room_id) {
                        room_cache.insert(
                            room_id.clone(),
                            MatrixRoom {
                                room_id: room_id.clone(),
                                name: None,
                                topic: None,
                                canonical_alias: None,
                                is_encrypted: false,
                                is_direct: false,
                                member_count: 0,
                            },
                        );
                    }
                }
            }
        }

        Ok(response)
    }

    /// Get joined rooms.
    pub async fn get_joined_rooms(&self) -> Vec<MatrixRoom> {
        self.rooms.read().await.values().cloned().collect()
    }

    /// Send a message to a room.
    pub async fn send_message(
        &self,
        text: &str,
        options: Option<MatrixMessageSendOptions>,
    ) -> Result<MatrixSendResult, MatrixError> {
        if !self.is_connected().await {
            return Err(MatrixError::NotConnected);
        }

        let opts = options.unwrap_or_default();
        let room_id = match &opts.room_id {
            Some(id) => id.clone(),
            None => return Ok(MatrixSendResult::err("Room ID is required")),
        };

        // Resolve room alias
        let resolved_room_id = if is_valid_matrix_room_alias(&room_id) {
            match self.resolve_room_alias(&room_id).await {
                Ok(resolved) => resolved,
                Err(e) => return Ok(MatrixSendResult::err(format!("Could not resolve alias: {}", e))),
            }
        } else {
            room_id.clone()
        };

        // Build content
        let mut content = json!({
            "msgtype": "m.text",
            "body": text
        });

        if opts.formatted {
            content["format"] = json!("org.matrix.custom.html");
            content["formatted_body"] = json!(text);
        }

        // Handle reply/thread
        if opts.thread_id.is_some() || opts.reply_to.is_some() {
            let mut relates_to = json!({});
            if let Some(thread_id) = &opts.thread_id {
                relates_to["rel_type"] = json!("m.thread");
                relates_to["event_id"] = json!(thread_id);
            }
            if let Some(reply_to) = &opts.reply_to {
                relates_to["m.in_reply_to"] = json!({ "event_id": reply_to });
            }
            content["m.relates_to"] = relates_to;
        }

        // Send message
        let txn_id = uuid::Uuid::new_v4().to_string();
        let url = self.api_url(&format!(
            "/rooms/{}/send/m.room.message/{}",
            urlencoding::encode(&resolved_room_id),
            txn_id
        ));

        let response: SendMessageResponse = self
            .client
            .put(&url)
            .bearer_auth(&self.settings.access_token)
            .json(&content)
            .send()
            .await?
            .json()
            .await?;

        debug!("Message sent to {}: {}", resolved_room_id, response.event_id);

        Ok(MatrixSendResult::ok(response.event_id, resolved_room_id))
    }

    /// Send a reaction to a message.
    pub async fn send_reaction(
        &self,
        room_id: &str,
        event_id: &str,
        emoji: &str,
    ) -> Result<MatrixSendResult, MatrixError> {
        if !self.is_connected().await {
            return Err(MatrixError::NotConnected);
        }

        let content = json!({
            "m.relates_to": {
                "rel_type": "m.annotation",
                "event_id": event_id,
                "key": emoji
            }
        });

        let txn_id = uuid::Uuid::new_v4().to_string();
        let url = self.api_url(&format!(
            "/rooms/{}/send/m.reaction/{}",
            urlencoding::encode(room_id),
            txn_id
        ));

        let response: SendMessageResponse = self
            .client
            .put(&url)
            .bearer_auth(&self.settings.access_token)
            .json(&content)
            .send()
            .await?
            .json()
            .await?;

        Ok(MatrixSendResult::ok(response.event_id, room_id.to_string()))
    }

    /// Resolve a room alias to a room ID.
    async fn resolve_room_alias(&self, alias: &str) -> Result<String, MatrixError> {
        let url = self.api_url(&format!(
            "/directory/room/{}",
            urlencoding::encode(alias)
        ));

        let response: RoomAliasResponse = self
            .client
            .get(&url)
            .bearer_auth(&self.settings.access_token)
            .send()
            .await?
            .json()
            .await?;

        Ok(response.room_id)
    }

    /// Join a room.
    pub async fn join_room(&self, room_id_or_alias: &str) -> Result<String, MatrixError> {
        if !self.is_connected().await {
            return Err(MatrixError::NotConnected);
        }

        let url = self.api_url(&format!(
            "/join/{}",
            urlencoding::encode(room_id_or_alias)
        ));

        let response: JoinRoomResponse = self
            .client
            .post(&url)
            .bearer_auth(&self.settings.access_token)
            .json(&json!({}))
            .send()
            .await?
            .json()
            .await?;

        info!("Joined room {}", response.room_id);

        // Add to room cache
        let mut rooms = self.rooms.write().await;
        rooms.insert(
            response.room_id.clone(),
            MatrixRoom {
                room_id: response.room_id.clone(),
                name: None,
                topic: None,
                canonical_alias: if is_valid_matrix_room_alias(room_id_or_alias) {
                    Some(room_id_or_alias.to_string())
                } else {
                    None
                },
                is_encrypted: false,
                is_direct: false,
                member_count: 0,
            },
        );

        Ok(response.room_id)
    }

    /// Leave a room.
    pub async fn leave_room(&self, room_id: &str) -> Result<(), MatrixError> {
        if !self.is_connected().await {
            return Err(MatrixError::NotConnected);
        }

        let url = self.api_url(&format!(
            "/rooms/{}/leave",
            urlencoding::encode(room_id)
        ));

        self.client
            .post(&url)
            .bearer_auth(&self.settings.access_token)
            .json(&json!({}))
            .send()
            .await?;

        info!("Left room {}", room_id);

        // Remove from room cache
        self.rooms.write().await.remove(room_id);

        Ok(())
    }

    /// Send typing indicator.
    pub async fn send_typing(
        &self,
        room_id: &str,
        typing: bool,
        timeout: u32,
    ) -> Result<(), MatrixError> {
        if !self.is_connected().await {
            return Err(MatrixError::NotConnected);
        }

        let url = self.api_url(&format!(
            "/rooms/{}/typing/{}",
            urlencoding::encode(room_id),
            urlencoding::encode(&self.settings.user_id)
        ));

        let body = if typing {
            json!({ "typing": true, "timeout": timeout })
        } else {
            json!({ "typing": false })
        };

        self.client
            .put(&url)
            .bearer_auth(&self.settings.access_token)
            .json(&body)
            .send()
            .await?;

        Ok(())
    }

    /// Send read receipt.
    pub async fn send_read_receipt(
        &self,
        room_id: &str,
        event_id: &str,
    ) -> Result<(), MatrixError> {
        if !self.is_connected().await {
            return Err(MatrixError::NotConnected);
        }

        let url = self.api_url(&format!(
            "/rooms/{}/receipt/m.read/{}",
            urlencoding::encode(room_id),
            urlencoding::encode(event_id)
        ));

        self.client
            .post(&url)
            .bearer_auth(&self.settings.access_token)
            .json(&json!({}))
            .send()
            .await?;

        Ok(())
    }
}
