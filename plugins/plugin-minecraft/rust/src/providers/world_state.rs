use crate::services::MinecraftService;
use std::collections::HashMap;
use std::sync::Arc;

use super::ProviderResult;

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

