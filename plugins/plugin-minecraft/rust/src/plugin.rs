use crate::actions::{
    mc_attack, mc_chat, mc_connect, mc_control, mc_dig, mc_disconnect, mc_goto, mc_look, mc_place,
    mc_scan, mc_stop,
};
use crate::providers::{get_vision, get_waypoints, get_world_state};
use crate::services::{MinecraftService, WaypointsService};
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
    pub waypoints: Arc<WaypointsService>,
}

impl MinecraftPlugin {
    pub fn new(config: MinecraftConfig) -> Self {
        Self {
            name: "plugin-minecraft".to_string(),
            description: "Minecraft automation plugin (Mineflayer bridge client)".to_string(),
            config,
            service: None,
            waypoints: Arc::new(WaypointsService::new()),
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

    pub async fn handle_action(&self, action_name: &str, message: &str) -> Result<Value, String> {
        let service = self
            .service
            .as_ref()
            .ok_or("Minecraft service not initialized")?;

        match action_name {
            "MC_CONNECT" => {
                let bot_id = mc_connect(Arc::clone(service)).await?;
                Ok(serde_json::json!({"botId": bot_id, "success": true}))
            }
            "MC_DISCONNECT" => {
                mc_disconnect(Arc::clone(service)).await?;
                Ok(serde_json::json!({"disconnected": true, "success": true}))
            }
            "MC_CHAT" => {
                mc_chat(Arc::clone(service), message).await?;
                Ok(serde_json::json!({"sent": true, "success": true}))
            }
            "MC_GOTO" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 3 {
                    return Err("Expected 'x y z'".to_string());
                }
                let x = parts[0].parse::<f64>().map_err(|_| "bad x")?;
                let y = parts[1].parse::<f64>().map_err(|_| "bad y")?;
                let z = parts[2].parse::<f64>().map_err(|_| "bad z")?;
                mc_goto(Arc::clone(service), x, y, z).await?;
                Ok(serde_json::json!({"success": true}))
            }
            "MC_STOP" => {
                mc_stop(Arc::clone(service)).await?;
                Ok(serde_json::json!({"success": true}))
            }
            "MC_DIG" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 3 {
                    return Err("Expected 'x y z'".to_string());
                }
                let x = parts[0].parse::<f64>().map_err(|_| "bad x")?;
                let y = parts[1].parse::<f64>().map_err(|_| "bad y")?;
                let z = parts[2].parse::<f64>().map_err(|_| "bad z")?;
                mc_dig(Arc::clone(service), x, y, z).await?;
                Ok(serde_json::json!({"success": true}))
            }
            "MC_PLACE" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 4 {
                    return Err("Expected 'x y z face'".to_string());
                }
                let x = parts[0].parse::<f64>().map_err(|_| "bad x")?;
                let y = parts[1].parse::<f64>().map_err(|_| "bad y")?;
                let z = parts[2].parse::<f64>().map_err(|_| "bad z")?;
                mc_place(Arc::clone(service), x, y, z, parts[3]).await?;
                Ok(serde_json::json!({"success": true}))
            }
            "MC_LOOK" => {
                let parts: Vec<&str> = message.split_whitespace().collect();
                if parts.len() < 2 {
                    return Err("Expected 'yaw pitch'".to_string());
                }
                let yaw = parts[0].parse::<f64>().map_err(|_| "bad yaw")?;
                let pitch = parts[1].parse::<f64>().map_err(|_| "bad pitch")?;
                mc_look(Arc::clone(service), yaw, pitch).await?;
                Ok(serde_json::json!({"success": true}))
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
                mc_control(Arc::clone(service), control, state, duration_ms).await?;
                Ok(serde_json::json!({"success": true}))
            }
            "MC_ATTACK" => {
                let entity_id = message.trim().parse::<i64>().map_err(|_| "bad entityId")?;
                mc_attack(Arc::clone(service), entity_id).await?;
                Ok(serde_json::json!({"success": true}))
            }
            "MC_SCAN" => {
                // Parse optional JSON parameters: {"blocks": [...], "radius": 16, "maxResults": 32}
                let mut blocks: Option<Vec<String>> = None;
                let mut radius: Option<u32> = None;
                let mut max_results: Option<u32> = None;

                if message.trim().starts_with('{') && message.trim().ends_with('}') {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(message) {
                        if let Some(arr) = parsed.get("blocks").and_then(|v| v.as_array()) {
                            blocks = Some(
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect(),
                            );
                        }
                        if let Some(r) = parsed.get("radius").and_then(|v| v.as_u64()) {
                            radius = Some(r as u32);
                        }
                        if let Some(m) = parsed.get("maxResults").and_then(|v| v.as_u64()) {
                            max_results = Some(m as u32);
                        }
                    }
                }

                let result = mc_scan(Arc::clone(service), blocks, radius, max_results).await?;
                Ok(serde_json::json!({
                    "text": format!("Scan found {} blocks.", result.count),
                    "success": true,
                    "data": { "blocks": result.blocks },
                    "values": { "count": result.count }
                }))
            }
            "MC_WAYPOINT_SET" => {
                let name = message.trim();
                if name.is_empty() {
                    return Err("Missing waypoint name".to_string());
                }

                let state = service.get_state().await?;
                let connected = state.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
                if !connected {
                    return Err("Bot not connected".to_string());
                }

                let position = state.get("position").ok_or("No position available")?;
                let x = position.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = position.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let z = position.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);

                let wp = self.waypoints.set_waypoint(name, x, y, z);
                Ok(serde_json::json!({
                    "text": format!("Saved waypoint \"{}\" at ({:.1}, {:.1}, {:.1}).", name, x, y, z),
                    "success": true,
                    "data": {
                        "name": wp.name,
                        "x": wp.x,
                        "y": wp.y,
                        "z": wp.z,
                        "createdAt": wp.created_at.to_rfc3339()
                    }
                }))
            }
            "MC_WAYPOINT_DELETE" => {
                let name = message.trim();
                if name.is_empty() {
                    return Err("Missing waypoint name".to_string());
                }

                let deleted = self.waypoints.delete_waypoint(name);
                if deleted {
                    Ok(serde_json::json!({
                        "text": format!("Deleted waypoint \"{}\".", name),
                        "success": true,
                        "values": { "deleted": true }
                    }))
                } else {
                    Ok(serde_json::json!({
                        "text": format!("No waypoint named \"{}\".", name),
                        "success": false,
                        "values": { "deleted": false }
                    }))
                }
            }
            "MC_WAYPOINT_LIST" => {
                let wp_list = self.waypoints.list_waypoints();
                if wp_list.is_empty() {
                    Ok(serde_json::json!({
                        "text": "No waypoints saved.",
                        "success": true,
                        "data": { "waypoints": [] }
                    }))
                } else {
                    let lines: Vec<String> = wp_list
                        .iter()
                        .map(|w| format!("- {}: ({:.1}, {:.1}, {:.1})", w.name, w.x, w.y, w.z))
                        .collect();
                    let waypoints_data: Vec<serde_json::Value> = wp_list
                        .iter()
                        .map(|w| {
                            serde_json::json!({
                                "name": w.name,
                                "x": w.x,
                                "y": w.y,
                                "z": w.z,
                                "createdAt": w.created_at.to_rfc3339()
                            })
                        })
                        .collect();
                    Ok(serde_json::json!({
                        "text": format!("Waypoints:\n{}", lines.join("\n")),
                        "success": true,
                        "data": { "waypoints": waypoints_data }
                    }))
                }
            }
            "MC_WAYPOINT_GOTO" => {
                let name = message.trim();
                if name.is_empty() {
                    return Err("Missing waypoint name".to_string());
                }

                let wp = self.waypoints.get_waypoint(name)
                    .ok_or_else(|| format!("No waypoint named \"{}\".", name))?;

                mc_goto(Arc::clone(service), wp.x, wp.y, wp.z).await?;
                Ok(serde_json::json!({
                    "text": format!("Navigating to waypoint \"{}\" at ({:.1}, {:.1}, {:.1}).", wp.name, wp.x, wp.y, wp.z),
                    "success": true
                }))
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
            "MC_VISION" => {
                let result = get_vision(Arc::clone(service)).await;
                Ok(json!({
                    "text": result.text,
                    "values": result.values,
                    "data": result.data,
                }))
            }
            "MC_WAYPOINTS" => {
                let result = get_waypoints(&self.waypoints);
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

