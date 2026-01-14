use serde_json::json;
use std::collections::HashMap;

use super::ProviderResult;
use crate::services::WaypointsService;

/// Provider that returns all saved waypoints
pub fn get_waypoints(waypoints_service: &WaypointsService) -> ProviderResult {
    let wp_list = waypoints_service.list_waypoints();

    if wp_list.is_empty() {
        return ProviderResult {
            text: "No waypoints saved.".to_string(),
            values: {
                let mut v = HashMap::new();
                v.insert("count".to_string(), json!(0));
                v
            },
            data: {
                let mut d = HashMap::new();
                d.insert("waypoints".to_string(), json!([]));
                d
            },
        };
    }

    let lines: Vec<String> = wp_list
        .iter()
        .map(|w| format!("- {}: ({:.1}, {:.1}, {:.1})", w.name, w.x, w.y, w.z))
        .collect();

    let waypoints_data: Vec<serde_json::Value> = wp_list
        .iter()
        .map(|w| {
            json!({
                "name": w.name,
                "x": w.x,
                "y": w.y,
                "z": w.z,
                "createdAt": w.created_at.to_rfc3339(),
            })
        })
        .collect();

    ProviderResult {
        text: format!("Waypoints:\n{}", lines.join("\n")),
        values: {
            let mut v = HashMap::new();
            v.insert("count".to_string(), json!(wp_list.len()));
            v
        },
        data: {
            let mut d = HashMap::new();
            d.insert("waypoints".to_string(), json!(waypoints_data));
            d
        },
    }
}
