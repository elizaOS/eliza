use crate::actions::{
    mc_attack, mc_chat, mc_connect, mc_control, mc_dig, mc_disconnect, mc_goto, mc_look, mc_place,
    mc_stop,
};
use crate::providers::get_world_state;
use crate::services::MinecraftService;
use crate::types::MinecraftConfig;
use serde_json::Value;
use std::env;
use std::sync::Arc;
use tracing::info;

pub struct MinecraftPlugin {
    pub name: String,
    pub description: String,
    pub config: MinecraftConfig,
    pub service: Option<Arc<MinecraftService>>,
}

impl MinecraftPlugin {
    pub fn new(config: MinecraftConfig) -> Self {
        Self {
            name: "plugin-minecraft".to_string(),
            description: "Minecraft automation plugin (Mineflayer bridge client)".to_string(),
            config,
            service: None,
        }
    }

    pub async fn init(&mut self) -> Result<(), String> {
        let port = env::var("MC_SERVER_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(3457);
        self.config = MinecraftConfig { server_port: port };
        let service = MinecraftService::new(self.config.clone());
        service.start().await?;
        self.service = Some(Arc::new(service));
        info!("Minecraft plugin initialized");
        Ok(())
    }

    pub async fn stop(&mut self) {
        if let Some(service) = &self.service {
            service.stop().await;
        }
        self.service = None;
    }

    pub async fn handle_action(&self, action_name: &str, message: &str) -> Result<(), String> {
        let service = self
            .service
            .as_ref()
            .ok_or("Minecraft service not initialized")?;

        match action_name {
            "MC_CONNECT" => {
                let _ = mc_connect(Arc::clone(service)).await?;
                Ok(())
            }
            "MC_DISCONNECT" => mc_disconnect(Arc::clone(service)).await,
            "MC_CHAT" => mc_chat(Arc::clone(service), message).await,
            "MC_GOTO" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 3 {
                    return Err("Expected 'x y z'".to_string());
                }
                let x = parts[0].parse::<f64>().map_err(|_| "bad x")?;
                let y = parts[1].parse::<f64>().map_err(|_| "bad y")?;
                let z = parts[2].parse::<f64>().map_err(|_| "bad z")?;
                mc_goto(Arc::clone(service), x, y, z).await
            }
            "MC_STOP" => mc_stop(Arc::clone(service)).await,
            "MC_DIG" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 3 {
                    return Err("Expected 'x y z'".to_string());
                }
                let x = parts[0].parse::<f64>().map_err(|_| "bad x")?;
                let y = parts[1].parse::<f64>().map_err(|_| "bad y")?;
                let z = parts[2].parse::<f64>().map_err(|_| "bad z")?;
                mc_dig(Arc::clone(service), x, y, z).await
            }
            "MC_PLACE" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 4 {
                    return Err("Expected 'x y z face'".to_string());
                }
                let x = parts[0].parse::<f64>().map_err(|_| "bad x")?;
                let y = parts[1].parse::<f64>().map_err(|_| "bad y")?;
                let z = parts[2].parse::<f64>().map_err(|_| "bad z")?;
                mc_place(Arc::clone(service), x, y, z, parts[3]).await
            }
            "MC_LOOK" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 2 {
                    return Err("Expected 'yaw pitch'".to_string());
                }
                let yaw = parts[0].parse::<f64>().map_err(|_| "bad yaw")?;
                let pitch = parts[1].parse::<f64>().map_err(|_| "bad pitch")?;
                mc_look(Arc::clone(service), yaw, pitch).await
            }
            "MC_CONTROL" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 2 {
                    return Err("Expected 'control true|false [durationMs]'".to_string());
                }
                let control = parts[0];
                let state = parts[1].to_lowercase() == "true";
                let duration_ms = if parts.len() >= 3 {
                    Some(parts[2].parse::<u64>().map_err(|_| "bad duration")?)
                } else {
                    None
                };
                mc_control(Arc::clone(service), control, state, duration_ms).await
            }
            "MC_ATTACK" => {
                let entity_id = message.trim().parse::<i64>().map_err(|_| "bad entityId")?;
                mc_attack(Arc::clone(service), entity_id).await
            }
            _ => Err(format!("Unknown action: {}", action_name)),
        }
    }

    pub async fn get_provider(&self, provider_name: &str) -> Result<Value, String> {
        use serde_json::json;
        let service = self
            .service
            .as_ref()
            .ok_or("Minecraft service not initialized")?;

        match provider_name {
            "MC_WORLD_STATE" => {
                let result = get_world_state(Arc::clone(service)).await;
                Ok(json!({
                    "text": result.text,
                    "values": result.values,
                    "data": result.data,
                }))
            }
            _ => Err(format!("Unknown provider: {}", provider_name)),
        }
    }
}

pub fn create_minecraft_plugin(config: Option<MinecraftConfig>) -> MinecraftPlugin {
    MinecraftPlugin::new(config.unwrap_or_default())
}

