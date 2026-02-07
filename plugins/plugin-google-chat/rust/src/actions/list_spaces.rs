//! List spaces action for Google Chat plugin.

use crate::service::GoogleChatService;
use crate::types::{get_space_display_name, is_direct_message, GoogleChatSpace};
use serde::{Deserialize, Serialize};

/// Result from the list spaces action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSpacesResult {
    pub success: bool,
    pub space_count: usize,
    pub spaces: Vec<SpaceInfo>,
    pub formatted_text: String,
    pub error: Option<String>,
}

/// Space information for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceInfo {
    pub name: String,
    pub display_name: Option<String>,
    pub space_type: String,
    pub threaded: bool,
}

impl From<GoogleChatSpace> for SpaceInfo {
    fn from(space: GoogleChatSpace) -> Self {
        Self {
            name: space.name,
            display_name: space.display_name,
            space_type: space.space_type,
            threaded: space.threaded,
        }
    }
}

/// Execute the list spaces action.
pub async fn execute_list_spaces(service: &GoogleChatService) -> ListSpacesResult {
    let spaces = match service.get_spaces().await {
        Ok(s) => s,
        Err(e) => {
            return ListSpacesResult {
                success: false,
                space_count: 0,
                spaces: Vec::new(),
                formatted_text: String::new(),
                error: Some(e.to_string()),
            }
        }
    };

    let space_infos: Vec<SpaceInfo> = spaces.iter().map(|s| s.clone().into()).collect();

    // Format space list
    let formatted = if space_infos.is_empty() {
        "Not currently in any Google Chat spaces.".to_string()
    } else {
        let space_lines: Vec<String> = spaces
            .iter()
            .map(|space| {
                let name = get_space_display_name(space);
                let space_type = if is_direct_message(space) {
                    "DM"
                } else {
                    &space.space_type
                };
                let threaded = if space.threaded { " (threaded)" } else { "" };
                format!("• {} [{}]{}", name, space_type, threaded)
            })
            .collect();

        format!(
            "Currently in {} space(s):\n\n{}",
            space_infos.len(),
            space_lines.join("\n")
        )
    };

    ListSpacesResult {
        success: true,
        space_count: space_infos.len(),
        spaces: space_infos,
        formatted_text: formatted,
        error: None,
    }
}
