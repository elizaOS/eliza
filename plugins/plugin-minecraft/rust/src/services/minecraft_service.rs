use crate::services::MinecraftWebSocketClient;
use crate::types::MinecraftConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

pub struct MinecraftService {
    client: Arc<MinecraftWebSocketClient>,
    bot_id: Arc<RwLock<Option<String>>>,
    initialized: Arc<RwLock<bool>>,
}

impl MinecraftService {
    pub fn new(config: MinecraftConfig) -> Self {
        let server_url = format!("ws://localhost:{}", config.server_port);
        Self {
            client: Arc::new(MinecraftWebSocketClient::new(&server_url)),
            bot_id: Arc::new(RwLock::new(None)),
            initialized: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        info!("Starting Minecraft service");
        self.client.connect().await?;
        self.wait_for_ready(20, 500).await?;
        *self.initialized.write().await = true;
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(bot_id) = self.bot_id.read().await.clone() {
            let _ = self.destroy_bot(&bot_id).await;
        }
        *self.initialized.write().await = false;
    }

    pub async fn create_bot(
        &self,
        overrides: HashMap<String, Value>,
    ) -> Result<String, String> {
        if !*self.initialized.read().await {
            return Err("Minecraft service not initialized".to_string());
        }
        let response = self.client.send_message("createBot", None, overrides).await?;
        let bot_id = response
            .data
            .as_ref()
            .and_then(|d| d.get("botId"))
            .and_then(|v| v.as_str())
            .ok_or("Bridge did not return botId")?
            .to_string();

        *self.bot_id.write().await = Some(bot_id.clone());
        Ok(bot_id)
    }

    pub async fn ensure_bot(&self) -> Result<String, String> {
        if let Some(bot_id) = self.bot_id.read().await.clone() {
            return Ok(bot_id);
        }
        self.create_bot(HashMap::new()).await
    }

    pub async fn current_bot_id(&self) -> Option<String> {
        self.bot_id.read().await.clone()
    }

    pub async fn destroy_bot(&self, bot_id: &str) -> Result<(), String> {
        let _ = self
            .client
            .send_message("destroyBot", Some(bot_id), HashMap::new())
            .await?;
        *self.bot_id.write().await = None;
        Ok(())
    }

    pub async fn request(
        &self,
        msg_type: &str,
        mut data: HashMap<String, Value>,
    ) -> Result<HashMap<String, Value>, String> {
        let bot_id = self.ensure_bot().await?;
        let response = self
            .client
            .send_message(msg_type, Some(&bot_id), std::mem::take(&mut data))
            .await?;
        Ok(response.data.unwrap_or_default())
    }

    pub async fn get_state(&self) -> Result<HashMap<String, Value>, String> {
        if self.bot_id.read().await.is_none() {
            let mut m = HashMap::new();
            m.insert("connected".to_string(), Value::Bool(false));
            return Ok(m);
        }
        let bot_id = self.ensure_bot().await?;
        let response = self
            .client
            .send_message("getState", Some(&bot_id), HashMap::new())
            .await?;
        Ok(response.data.unwrap_or_default())
    }

    async fn wait_for_ready(&self, max_attempts: u32, delay_ms: u64) -> Result<(), String> {
        for _ in 0..max_attempts {
            if self.client.health().await.unwrap_or(false) {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
        Err("Mineflayer bridge server did not become ready".to_string())
    }
}

