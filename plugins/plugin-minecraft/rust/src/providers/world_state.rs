use crate::services::MinecraftService;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub struct ProviderResult {
    pub text: String,
    pub values: HashMap<String, Value>,
    pub data: HashMap<String, Value>,
}

pub async fn get_world_state(service: Arc<MinecraftService>) -> ProviderResult {
    match service.get_state().await {
        Ok(data) => {
            let connected = data
                .get("connected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let text = if connected {
                "Minecraft world state available".to_string()
            } else {
                "Minecraft bot not connected".to_string()
            };
            ProviderResult {
                text,
                values: HashMap::new(),
                data,
            }
        }
        Err(e) => ProviderResult {
            text: format!("Error getting Minecraft state: {}", e),
            values: HashMap::new(),
            data: HashMap::new(),
        },
    }
}

