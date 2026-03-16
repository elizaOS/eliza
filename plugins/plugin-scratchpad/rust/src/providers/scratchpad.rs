#![allow(missing_docs)]
//! Scratchpad Provider – exposes scratchpad state to agent context.

use crate::service::ScratchpadService;
use regex::Regex;
use std::collections::HashMap;
use tracing::{error, info};

/// Result of the scratchpad provider.
pub struct ScratchpadProviderResult {
    /// Text description.
    pub text: String,
    /// Values map for template interpolation.
    pub values: HashMap<String, serde_json::Value>,
    /// Data map with structured entry information.
    pub data: HashMap<String, serde_json::Value>,
}

/// Scratchpad Provider.
///
/// Fetches and formats information about a user's scratchpad entries.
pub struct ScratchpadProvider;

impl ScratchpadProvider {
    /// Provider name.
    pub const NAME: &'static str = "scratchpad";

    /// Provider description.
    pub const DESCRIPTION: &'static str =
        "Provides information about the user's scratchpad entries - file-based notes and memories that persist across sessions.";

    /// Whether the provider is dynamic.
    pub const DYNAMIC: bool = true;

    /// Get scratchpad entries summary and data.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    ///
    /// # Returns
    ///
    /// The provider result with text summary, values, and data.
    pub async fn get(service: &ScratchpadService) -> ScratchpadProviderResult {
        info!("Getting scratchpad provider data");

        let entries = service.list().await;

        if entries.is_empty() {
            return ScratchpadProviderResult {
                text: "No scratchpad entries available.".to_string(),
                values: HashMap::from([(
                    "scratchpadCount".to_string(),
                    serde_json::json!(0),
                )]),
                data: HashMap::from([
                    ("entries".to_string(), serde_json::json!([])),
                    ("count".to_string(), serde_json::json!(0)),
                ]),
            };
        }

        let fm_re = Regex::new(r"^---[\s\S]*?---\n*").unwrap();

        // Build summary text
        let mut summary_lines = vec![
            format!("**Scratchpad** ({} entries available):", entries.len()),
            String::new(),
        ];

        // Show up to 5 most recent entries with previews
        for entry in entries.iter().take(5) {
            let content_no_fm = fm_re.replace(&entry.content, "").trim().to_string();
            let preview: String = content_no_fm.chars().take(80).collect();
            let preview = preview.replace('\n', " ");

            let tags_str = if !entry.tags.is_empty() {
                format!(" [{}]", entry.tags.join(", "))
            } else {
                String::new()
            };

            summary_lines.push(format!(
                "- **{}** ({}){}", entry.title, entry.id, tags_str
            ));
            summary_lines.push(format!(
                "  {}{}",
                preview,
                if content_no_fm.len() > 80 { "..." } else { "" }
            ));
        }

        if entries.len() > 5 {
            summary_lines.push(format!(
                "\n_...and {} more entries_",
                entries.len() - 5
            ));
        }

        summary_lines.push(
            "\n_Use SCRATCHPAD_SEARCH to find specific entries or SCRATCHPAD_READ to view full content._".to_string()
        );

        // Build data payload
        let entry_data: Vec<serde_json::Value> = entries
            .iter()
            .map(|e| {
                serde_json::json!({
                    "id": e.id,
                    "title": e.title,
                    "modifiedAt": e.modified_at.to_rfc3339(),
                    "tags": e.tags,
                })
            })
            .collect();

        let entry_ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();

        let mut values = HashMap::new();
        values.insert(
            "scratchpadCount".to_string(),
            serde_json::json!(entries.len()),
        );
        values.insert(
            "scratchpadEntryIds".to_string(),
            serde_json::json!(entry_ids.join(", ")),
        );

        let mut data = HashMap::new();
        data.insert("entries".to_string(), serde_json::json!(entry_data));
        data.insert("count".to_string(), serde_json::json!(entries.len()));
        data.insert(
            "basePath".to_string(),
            serde_json::json!(service.get_base_path()),
        );

        ScratchpadProviderResult {
            text: summary_lines.join("\n"),
            values,
            data,
        }
    }
}
