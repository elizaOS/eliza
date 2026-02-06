//! List groups action for Signal plugin.

use crate::service::SignalService;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for listing Signal groups (none required)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListGroupsParams {
    /// Whether to include groups the user has left
    #[serde(default)]
    pub include_left: bool,
}

/// Group info in result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub member_count: usize,
}

/// Result of listing Signal groups
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListGroupsResult {
    pub success: bool,
    pub group_count: usize,
    pub groups: Vec<GroupInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the list groups action
pub async fn execute_list_groups(
    service: Arc<SignalService>,
    params: ListGroupsParams,
) -> ListGroupsResult {
    match service.get_groups().await {
        Ok(groups) => {
            // Filter and sort groups
            let mut filtered: Vec<_> = groups
                .into_iter()
                .filter(|g| (params.include_left || g.is_member) && !g.is_blocked)
                .collect();

            filtered.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

            let group_infos: Vec<GroupInfo> = filtered
                .iter()
                .map(|g| GroupInfo {
                    id: g.id.clone(),
                    name: g.name.clone(),
                    description: g.description.clone(),
                    member_count: g.members.len(),
                })
                .collect();

            ListGroupsResult {
                success: true,
                group_count: group_infos.len(),
                groups: group_infos,
                error: None,
            }
        }
        Err(e) => ListGroupsResult {
            success: false,
            group_count: 0,
            groups: vec![],
            error: Some(e.to_string()),
        },
    }
}

/// Format groups as a human-readable string
pub fn format_groups_text(result: &ListGroupsResult) -> String {
    if !result.success {
        return format!(
            "Failed to list groups: {}",
            result.error.as_deref().unwrap_or("Unknown error")
        );
    }

    if result.groups.is_empty() {
        return "No groups found.".to_string();
    }

    let mut lines = vec![format!("Found {} groups:", result.group_count)];
    lines.push(String::new());

    for group in &result.groups {
        let mut line = format!("• {} ({} members)", group.name, group.member_count);

        if let Some(ref desc) = group.description {
            let truncated = if desc.len() > 50 {
                format!("{}...", &desc[..50])
            } else {
                desc.clone()
            };
            line.push_str(&format!(" - {}", truncated));
        }

        lines.push(line);
    }

    lines.join("\n")
}

/// Action metadata
pub const ACTION_NAME: &str = "SIGNAL_LIST_GROUPS";
pub const ACTION_DESCRIPTION: &str = "List Signal groups";
pub const ACTION_SIMILES: &[&str] = &[
    "LIST_SIGNAL_GROUPS",
    "SHOW_GROUPS",
    "GET_GROUPS",
    "SIGNAL_GROUPS",
];
