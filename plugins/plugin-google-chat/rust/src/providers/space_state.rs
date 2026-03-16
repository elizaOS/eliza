//! Space state provider for Google Chat plugin.

use crate::types::GoogleChatSpace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Space state data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceStateData {
    pub space_name: Option<String>,
    pub space_display_name: Option<String>,
    pub space_type: Option<String>,
    pub is_threaded: bool,
    pub is_direct: bool,
    pub connected: bool,
}

/// Space state provider result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceStateProviderResult {
    pub data: SpaceStateData,
    pub values: HashMap<String, serde_json::Value>,
    pub text: String,
}

/// Get the current Google Chat space state.
pub fn get_space_state(
    space: Option<&GoogleChatSpace>,
    agent_name: &str,
) -> SpaceStateProviderResult {
    let (space_name, space_display_name, space_type, is_threaded, is_dm) = space
        .map(|s| {
            let is_dm = s.space_type == "DM" || s.single_user_bot_dm;
            (
                Some(s.name.clone()),
                s.display_name.clone(),
                Some(s.space_type.clone()),
                s.threaded,
                is_dm,
            )
        })
        .unwrap_or((None, None, None, false, false));

    // Build response text
    let mut response_text = if is_dm {
        format!("{} is in a direct message conversation on Google Chat.", agent_name)
    } else {
        let label = space_display_name
            .as_ref()
            .or(space_name.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("a Google Chat space");
        let mut text = format!("{} is currently in Google Chat space \"{}\".", agent_name, label);
        if is_threaded {
            text.push_str(" This space uses threaded conversations.");
        }
        text
    };

    response_text.push_str("\n\nGoogle Chat is Google Workspace's team communication platform.");

    let data = SpaceStateData {
        space_name: space_name.clone(),
        space_display_name: space_display_name.clone(),
        space_type: space_type.clone(),
        is_threaded,
        is_direct: is_dm,
        connected: true,
    };

    let mut values = HashMap::new();
    if let Some(ref name) = space_name {
        values.insert("space_name".to_string(), serde_json::json!(name));
    }
    if let Some(ref display) = space_display_name {
        values.insert("space_display_name".to_string(), serde_json::json!(display));
    }
    if let Some(ref st) = space_type {
        values.insert("space_type".to_string(), serde_json::json!(st));
    }
    values.insert("is_threaded".to_string(), serde_json::json!(is_threaded));
    values.insert("is_direct".to_string(), serde_json::json!(is_dm));

    SpaceStateProviderResult {
        data,
        values,
        text: response_text,
    }
}
