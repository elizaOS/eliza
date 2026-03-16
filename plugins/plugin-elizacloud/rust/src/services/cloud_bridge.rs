//! CloudBridgeService — WebSocket bridge to cloud-hosted agents.

use std::collections::HashMap;
use tracing::{debug, info};

use crate::cloud_types::{BridgeConnection, BridgeConnectionState, BridgeMessage};

/// Internal state for a single WebSocket connection.
struct ActiveConnection {
    state: BridgeConnectionState,
    connected_at: Option<f64>,
    last_heartbeat: Option<f64>,
    reconnect_attempts: u32,
    next_request_id: u64,
}

/// WebSocket bridge to cloud-hosted elizaOS agents.
pub struct CloudBridgeService {
    connections: HashMap<String, ActiveConnection>,
}

impl CloudBridgeService {
    pub fn new() -> Self {
        Self {
            connections: HashMap::new(),
        }
    }

    pub async fn start(&mut self) {
        info!("[CloudBridge] Service initialized");
    }

    pub async fn stop(&mut self) {
        for (id, _) in self.connections.drain() {
            info!("[CloudBridge] Disconnected from {}", id);
        }
        info!("[CloudBridge] Service stopped");
    }

    // ─── Connection Management ─────────────────────────────────────────────

    pub async fn connect(&mut self, container_id: &str) {
        if let Some(conn) = self.connections.get(container_id) {
            if conn.state == BridgeConnectionState::Connected
                || conn.state == BridgeConnectionState::Connecting
            {
                debug!("[CloudBridge] Already connected/connecting to {}", container_id);
                return;
            }
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        self.connections.insert(
            container_id.to_string(),
            ActiveConnection {
                state: BridgeConnectionState::Connected,
                connected_at: Some(now),
                last_heartbeat: None,
                reconnect_attempts: 0,
                next_request_id: 1,
            },
        );
        info!("[CloudBridge] Connected to agent {}", container_id);
    }

    pub async fn disconnect(&mut self, container_id: &str) {
        if self.connections.remove(container_id).is_some() {
            info!("[CloudBridge] Disconnected from {}", container_id);
        }
    }

    // ─── Messaging ─────────────────────────────────────────────────────────

    /// Build a request message (for testing/offline use).
    pub fn build_request(
        &mut self,
        container_id: &str,
        method: &str,
        params: HashMap<String, serde_json::Value>,
    ) -> Result<BridgeMessage, String> {
        let conn = self
            .connections
            .get_mut(container_id)
            .ok_or_else(|| format!("Not connected to container {}", container_id))?;

        if conn.state != BridgeConnectionState::Connected {
            return Err(format!("Not connected to container {}", container_id));
        }

        let id = conn.next_request_id;
        conn.next_request_id += 1;

        Ok(BridgeMessage::new_request(id, method, params))
    }

    /// Build a notification message.
    pub fn build_notification(
        &self,
        container_id: &str,
        method: &str,
        params: HashMap<String, serde_json::Value>,
    ) -> Result<BridgeMessage, String> {
        let conn = self
            .connections
            .get(container_id)
            .ok_or_else(|| format!("Not connected to container {}", container_id))?;

        if conn.state != BridgeConnectionState::Connected {
            return Err(format!("Not connected to container {}", container_id));
        }

        Ok(BridgeMessage::new_notification(method, params))
    }

    // ─── Accessors ─────────────────────────────────────────────────────────

    pub fn connection_state(&self, container_id: &str) -> BridgeConnectionState {
        self.connections
            .get(container_id)
            .map(|c| c.state)
            .unwrap_or(BridgeConnectionState::Disconnected)
    }

    pub fn connection_info(&self, container_id: &str) -> Option<BridgeConnection> {
        self.connections.get(container_id).map(|c| BridgeConnection {
            container_id: container_id.to_string(),
            state: c.state,
            connected_at: c.connected_at,
            last_heartbeat: c.last_heartbeat,
            reconnect_attempts: c.reconnect_attempts,
        })
    }

    pub fn connected_container_ids(&self) -> Vec<String> {
        self.connections
            .iter()
            .filter(|(_, c)| c.state == BridgeConnectionState::Connected)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_connect_and_disconnect() {
        let mut svc = CloudBridgeService::new();
        svc.start().await;

        svc.connect("c-1").await;
        assert_eq!(svc.connection_state("c-1"), BridgeConnectionState::Connected);
        assert!(svc.connected_container_ids().contains(&"c-1".to_string()));

        svc.disconnect("c-1").await;
        assert_eq!(svc.connection_state("c-1"), BridgeConnectionState::Disconnected);
    }

    #[tokio::test]
    async fn test_build_request() {
        let mut svc = CloudBridgeService::new();
        svc.connect("c-1").await;

        let msg = svc.build_request("c-1", "message.send", HashMap::new());
        assert!(msg.is_ok());
        let msg = msg.unwrap();
        assert_eq!(msg.method.as_deref(), Some("message.send"));
    }

    #[tokio::test]
    async fn test_build_notification() {
        let mut svc = CloudBridgeService::new();
        svc.connect("c-1").await;

        let msg = svc.build_notification("c-1", "heartbeat", HashMap::new());
        assert!(msg.is_ok());
        assert!(msg.unwrap().id.is_none());
    }

    #[test]
    fn test_not_connected_errors() {
        let mut svc = CloudBridgeService::new();
        assert!(svc.build_request("c-1", "test", HashMap::new()).is_err());
        assert!(svc.build_notification("c-1", "test", HashMap::new()).is_err());
    }

    #[test]
    fn test_connection_info() {
        let svc = CloudBridgeService::new();
        assert!(svc.connection_info("nonexistent").is_none());
    }
}
