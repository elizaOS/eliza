use crate::actions::mc_scan;
use crate::services::MinecraftService;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use super::ProviderResult;

/// Vision provider: semantic environment context including biome, what we're looking at,
/// nearby blocks (logs/ores), and nearby entities.
pub async fn get_vision(service: Arc<MinecraftService>) -> ProviderResult {
    // First get world state
    let state = match service.get_state().await {
        Ok(s) => s,
        Err(e) => {
            return ProviderResult {
                text: format!("Error getting Minecraft state: {}", e),
                values: {
                    let mut v = HashMap::new();
                    v.insert("connected".to_string(), json!(false));
                    v
                },
                data: HashMap::new(),
            }
        }
    };

    let connected = state
        .get("connected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !connected {
        return ProviderResult {
            text: "Minecraft bot not connected".to_string(),
            values: {
                let mut v = HashMap::new();
                v.insert("connected".to_string(), json!(false));
                v
            },
            data: HashMap::new(),
        };
    }

    // Scan for key blocks to give spatial context
    let scan_blocks = vec![
        "oak_log".to_string(),
        "spruce_log".to_string(),
        "birch_log".to_string(),
        "jungle_log".to_string(),
        "acacia_log".to_string(),
        "dark_oak_log".to_string(),
        "stone".to_string(),
        "coal_ore".to_string(),
        "iron_ore".to_string(),
    ];

    let scan_result = mc_scan(Arc::clone(&service), Some(scan_blocks), Some(16), Some(24)).await;
    let nearby_blocks = scan_result.map(|r| r.blocks).unwrap_or_default();

    // Extract position
    let position = state.get("position");
    let pos_str = if let Some(pos) = position {
        let x = pos.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = pos.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let z = pos.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);
        format!("({:.1}, {:.1}, {:.1})", x, y, z)
    } else {
        "(unknown)".to_string()
    };

    // Extract biome
    let biome = state.get("biome");
    let biome_name = biome
        .and_then(|b| b.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string());

    // Extract what we're looking at
    let looking_at = state.get("lookingAt");
    let looking_text = if let Some(la) = looking_at {
        let la_name = la.get("name").and_then(|n| n.as_str());
        let la_pos = la.get("position");
        if let (Some(name), Some(pos)) = (la_name, la_pos) {
            let x = pos.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = pos.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let z = pos.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);
            format!("Looking at: {} at ({}, {}, {})", name, x, y, z)
        } else {
            "Looking at: (unknown)".to_string()
        }
    } else {
        "Looking at: (unknown)".to_string()
    };

    // Entity count
    let entities = state
        .get("nearbyEntities")
        .and_then(|e| e.as_array())
        .map(|a| a.clone())
        .unwrap_or_default();
    let entity_count = entities.len();

    let text = format!(
        "Biome: {}\nPosition: {}\n{}\nNearbyEntities: {}\nNearbyBlocksFound: {}",
        biome_name.as_deref().unwrap_or("unknown"),
        pos_str,
        looking_text,
        entity_count,
        nearby_blocks.len()
    );

    let mut values = HashMap::new();
    values.insert("connected".to_string(), json!(true));
    values.insert(
        "biome".to_string(),
        biome_name.map(|s| json!(s)).unwrap_or(Value::Null),
    );
    values.insert("entityCount".to_string(), json!(entity_count));
    values.insert("blocksFound".to_string(), json!(nearby_blocks.len()));

    let mut data = HashMap::new();
    data.insert(
        "biome".to_string(),
        biome.cloned().unwrap_or(Value::Null),
    );
    data.insert(
        "position".to_string(),
        position.cloned().unwrap_or(Value::Null),
    );
    data.insert(
        "lookingAt".to_string(),
        looking_at.cloned().unwrap_or(Value::Null),
    );
    data.insert("nearbyEntities".to_string(), json!(entities));
    data.insert("nearbyBlocks".to_string(), json!(nearby_blocks));

    ProviderResult { text, values, data }
}
