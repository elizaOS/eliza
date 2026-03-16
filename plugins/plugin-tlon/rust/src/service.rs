//! Tlon service implementation.

use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::client::{PokeParams, SubscribeParams, TlonClient};
use crate::config::{format_ship, normalize_ship, parse_channel_nest, TlonConfig};
use crate::error::{Result, TlonError};
use crate::types::TlonEventType;

/// Callback for events.
pub type EventCallback = Box<dyn Fn(TlonEventType, serde_json::Value) + Send + Sync>;

/// Service state.
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    subscribed_channels: HashSet<String>,
    subscribed_dms: HashSet<String>,
    processed_messages: std::collections::HashMap<String, i64>,
}

impl Default for ServiceState {
    fn default() -> Self {
        Self {
            is_running: false,
            event_callback: None,
            subscribed_channels: HashSet::new(),
            subscribed_dms: HashSet::new(),
            processed_messages: std::collections::HashMap::new(),
        }
    }
}

/// Tlon service for managing Urbit connections.
pub struct TlonService {
    config: TlonConfig,
    client: Option<TlonClient>,
    state: Arc<RwLock<ServiceState>>,
}

impl TlonService {
    /// Creates a new service from a config.
    pub fn new(config: TlonConfig) -> Self {
        Self {
            config,
            client: None,
            state: Arc::new(RwLock::new(ServiceState::default())),
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &TlonConfig {
        &self.config
    }

    /// Returns whether the service is running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Sets a callback for events.
    pub async fn set_event_callback<F>(&self, callback: F)
    where
        F: Fn(TlonEventType, serde_json::Value) + Send + Sync + 'static,
    {
        let mut state = self.state.write().await;
        state.event_callback = Some(Box::new(callback));
    }

    /// Starts the Tlon service.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(TlonError::AlreadyRunning);
            }
        }

        self.config.validate()?;

        if !self.config.enabled {
            info!("[Tlon] Plugin is disabled");
            return Ok(());
        }

        info!("[Tlon] Starting service for ~{}", self.config.ship);

        let client = TlonClient::authenticate(
            &self.config.url,
            &self.config.code,
            Some(&self.config.ship),
        )
        .await?;

        self.client = Some(client);

        // Initialize subscriptions
        self.initialize_subscriptions().await?;

        // Connect
        if let Some(ref client) = self.client {
            client.connect().await?;
        }

        {
            let mut state = self.state.write().await;
            state.is_running = true;
        }

        self.emit_event(
            TlonEventType::WorldConnected,
            serde_json::json!({
                "ship": self.config.ship,
                "url": self.config.url
            }),
        )
        .await;

        info!("[Tlon] Service started successfully");
        Ok(())
    }

    /// Stops the Tlon service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("[Tlon] Stopping service...");

        if let Some(ref client) = self.client {
            client.close().await?;
        }
        self.client = None;

        {
            let mut state = self.state.write().await;
            state.is_running = false;
            state.subscribed_channels.clear();
            state.subscribed_dms.clear();
            state.processed_messages.clear();
        }

        self.emit_event(
            TlonEventType::WorldLeft,
            serde_json::json!({
                "ship": self.config.ship
            }),
        )
        .await;

        info!("[Tlon] Service stopped");
        Ok(())
    }

    async fn initialize_subscriptions(&mut self) -> Result<()> {
        let client = self.client.as_ref().ok_or(TlonError::ClientNotInitialized)?;

        // Discover DMs
        match client.scry::<Vec<String>>("/chat/dm.json").await {
            Ok(dm_list) => {
                info!("[Tlon] Found {} DM conversation(s)", dm_list.len());
                for dm_ship in dm_list {
                    self.subscribe_to_dm(&dm_ship).await?;
                }
            }
            Err(e) => {
                warn!("[Tlon] Failed to fetch DM list: {}", e);
            }
        }

        // Subscribe to channels
        let mut channels = self.config.group_channels.clone();

        if self.config.auto_discover_channels {
            match self.discover_channels().await {
                Ok(discovered) if !discovered.is_empty() => {
                    channels = discovered;
                }
                Ok(_) => {}
                Err(e) => {
                    warn!("[Tlon] Auto-discovery failed: {}", e);
                }
            }
        }

        for channel_nest in channels {
            self.subscribe_to_channel(&channel_nest).await?;
        }

        let state = self.state.read().await;
        info!(
            "[Tlon] Subscribed to {} DMs and {} channels",
            state.subscribed_dms.len(),
            state.subscribed_channels.len()
        );

        Ok(())
    }

    async fn discover_channels(&self) -> Result<Vec<String>> {
        let client = self.client.as_ref().ok_or(TlonError::ClientNotInitialized)?;

        match client
            .scry::<std::collections::HashMap<String, serde_json::Value>>("/channels/channels.json")
            .await
        {
            Ok(channels) => Ok(channels.keys().cloned().collect()),
            Err(_) => Ok(Vec::new()),
        }
    }

    async fn subscribe_to_dm(&mut self, dm_ship: &str) -> Result<()> {
        let ship = normalize_ship(dm_ship);

        {
            let state = self.state.read().await;
            if state.subscribed_dms.contains(&ship) {
                return Ok(());
            }
        }

        let client = self.client.as_ref().ok_or(TlonError::ClientNotInitialized)?;
        let path = format!("/dm/{}", ship);

        client
            .subscribe(SubscribeParams {
                app: "chat".to_string(),
                path,
                event: None, // TODO: Wire up event handlers
                err: None,
                quit: None,
            })
            .await?;

        {
            let mut state = self.state.write().await;
            state.subscribed_dms.insert(ship.clone());
        }

        debug!("[Tlon] Subscribed to DM with {}", ship);
        Ok(())
    }

    async fn subscribe_to_channel(&mut self, channel_nest: &str) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.subscribed_channels.contains(channel_nest) {
                return Ok(());
            }
        }

        let _parsed = parse_channel_nest(channel_nest)
            .ok_or_else(|| TlonError::InvalidArgument(format!("Invalid channel: {}", channel_nest)))?;

        let client = self.client.as_ref().ok_or(TlonError::ClientNotInitialized)?;
        let path = format!("/{}", channel_nest);

        client
            .subscribe(SubscribeParams {
                app: "channels".to_string(),
                path,
                event: None, // TODO: Wire up event handlers
                err: None,
                quit: None,
            })
            .await?;

        {
            let mut state = self.state.write().await;
            state.subscribed_channels.insert(channel_nest.to_string());
        }

        debug!("[Tlon] Subscribed to channel: {}", channel_nest);
        Ok(())
    }

    /// Send a direct message.
    pub async fn send_dm(&self, to_ship: &str, text: &str) -> Result<String> {
        let client = self.client.as_ref().ok_or(TlonError::ClientNotInitialized)?;
        let to = normalize_ship(to_ship);
        let from = &self.config.ship;

        let sent_at = chrono::Utc::now().timestamp_millis();
        let id = format!("{}/{}", format_ship(from), sent_at);

        let story = serde_json::json!([{ "inline": [text] }]);
        let delta = serde_json::json!({
            "add": {
                "memo": {
                    "content": story,
                    "author": format_ship(from),
                    "sent": sent_at
                },
                "kind": null,
                "time": null
            }
        });

        let action = serde_json::json!({
            "ship": format_ship(&to),
            "diff": { "id": id, "delta": delta }
        });

        client
            .poke(PokeParams {
                app: "chat".to_string(),
                mark: "chat-dm-action".to_string(),
                json: action,
            })
            .await?;

        Ok(id)
    }

    /// Send a group channel message.
    pub async fn send_channel_message(
        &self,
        channel_nest: &str,
        text: &str,
        reply_to_id: Option<&str>,
    ) -> Result<String> {
        let client = self.client.as_ref().ok_or(TlonError::ClientNotInitialized)?;
        let from = &self.config.ship;

        let _parsed = parse_channel_nest(channel_nest)
            .ok_or_else(|| TlonError::InvalidArgument(format!("Invalid channel: {}", channel_nest)))?;

        let sent_at = chrono::Utc::now().timestamp_millis();
        let story = serde_json::json!([{ "inline": [text] }]);

        let action_content = if let Some(reply_id) = reply_to_id {
            serde_json::json!({
                "post": {
                    "reply": {
                        "id": reply_id,
                        "action": {
                            "add": {
                                "content": story,
                                "author": format_ship(from),
                                "sent": sent_at
                            }
                        }
                    }
                }
            })
        } else {
            serde_json::json!({
                "post": {
                    "add": {
                        "content": story,
                        "author": format_ship(from),
                        "sent": sent_at,
                        "kind": "/chat",
                        "blob": null,
                        "meta": null
                    }
                }
            })
        };

        let action = serde_json::json!({
            "channel": {
                "nest": channel_nest,
                "action": action_content
            }
        });

        client
            .poke(PokeParams {
                app: "channels".to_string(),
                mark: "channel-action-1".to_string(),
                json: action,
            })
            .await?;

        Ok(format!("{}/{}", format_ship(from), sent_at))
    }

    async fn emit_event(&self, event_type: TlonEventType, payload: serde_json::Value) {
        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(event_type, payload);
        }
    }

    /// Get the underlying client.
    pub fn client(&self) -> Option<&TlonClient> {
        self.client.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_creation() {
        let config = TlonConfig::new(
            "sampel-palnet".to_string(),
            "https://example.com".to_string(),
            "code".to_string(),
        );
        let service = TlonService::new(config);
        assert_eq!(service.config().ship, "sampel-palnet");
    }
}
