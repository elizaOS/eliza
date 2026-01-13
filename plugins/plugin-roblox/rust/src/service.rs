#![allow(missing_docs)]

use crate::client::RobloxClient;
use crate::config::RobloxConfig;
use crate::error::Result;
use crate::types::MessagingServiceMessage;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use uuid::Uuid;

pub struct RobloxService {
    client: Arc<RobloxClient>,
    config: RobloxConfig,
    agent_id: Uuid,
    agent_name: String,
    is_running: Arc<RwLock<bool>>,
}

impl RobloxService {
    pub fn new(
        config: RobloxConfig,
        agent_id: Uuid,
        agent_name: impl Into<String>,
    ) -> Result<Self> {
        let client = RobloxClient::new(config.clone())?;

        Ok(Self {
            client: Arc::new(client),
            config,
            agent_id,
            agent_name: agent_name.into(),
            is_running: Arc::new(RwLock::new(false)),
        })
    }

    pub async fn start(&self) -> Result<()> {
        let mut running = self.is_running.write().await;
        if *running {
            warn!("Roblox service already running");
            return Ok(());
        }

        *running = true;
        info!(
            universe_id = %self.config.universe_id,
            agent_id = %self.agent_id,
            "Roblox service started"
        );

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut running = self.is_running.write().await;
        if !*running {
            debug!("Roblox service not running");
            return Ok(());
        }

        *running = false;
        info!(agent_id = %self.agent_id, "Roblox service stopped");

        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        *self.is_running.read().await
    }

    pub fn client(&self) -> &RobloxClient {
        &self.client
    }

    pub fn config(&self) -> &RobloxConfig {
        &self.config
    }

    pub fn agent_id(&self) -> Uuid {
        self.agent_id
    }

    pub fn agent_name(&self) -> &str {
        &self.agent_name
    }

    pub async fn send_message(
        &self,
        content: impl Into<String>,
        target_player_ids: Option<Vec<u64>>,
    ) -> Result<()> {
        let message = MessagingServiceMessage {
            topic: self.config.messaging_topic.clone(),
            data: serde_json::json!({
                "type": "agent_message",
                "content": content.into(),
                "targetPlayerIds": target_player_ids,
                "timestamp": chrono::Utc::now().timestamp_millis(),
            }),
            sender: Some(crate::types::MessageSender {
                agent_id: self.agent_id,
                agent_name: self.agent_name.clone(),
            }),
        };

        self.client.send_agent_message(&message).await
    }

    pub async fn execute_action(
        &self,
        action_name: impl Into<String>,
        parameters: serde_json::Value,
        target_player_ids: Option<Vec<u64>>,
    ) -> Result<()> {
        let message = MessagingServiceMessage {
            topic: self.config.messaging_topic.clone(),
            data: serde_json::json!({
                "type": "agent_action",
                "action": action_name.into(),
                "parameters": parameters,
                "targetPlayerIds": target_player_ids,
                "timestamp": chrono::Utc::now().timestamp_millis(),
            }),
            sender: Some(crate::types::MessageSender {
                agent_id: self.agent_id,
                agent_name: self.agent_name.clone(),
            }),
        };

        self.client.send_agent_message(&message).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_service_lifecycle() {
        let config = RobloxConfig::new("test-key", "12345").with_dry_run(true);
        let service = RobloxService::new(config, Uuid::new_v4(), "TestAgent").unwrap();

        assert!(!service.is_running().await);

        service.start().await.unwrap();
        assert!(service.is_running().await);

        service.stop().await.unwrap();
        assert!(!service.is_running().await);
    }
}
