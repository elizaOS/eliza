#![allow(missing_docs)]
//! SCRATCHPAD_LIST action – list all scratchpad entries.

use crate::service::ScratchpadService;
use crate::types::ScratchpadEntry;
use tracing::info;

/// Result of the list action.
pub struct ListResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
    /// Listed entries.
    pub entries: Vec<ScratchpadEntry>,
}

/// SCRATCHPAD_LIST action.
pub struct ScratchpadListAction;

impl ScratchpadListAction {
    /// Action name.
    pub const NAME: &'static str = "SCRATCHPAD_LIST";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "List all scratchpad entries with their titles, IDs, tags, and modification dates.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SCRATCHPAD_LIST",
        "LIST_NOTES",
        "SHOW_NOTES",
        "MY_NOTES",
        "ALL_NOTES",
        "SHOW_SCRATCHPAD",
    ];

    /// Handle the list action.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    pub async fn handle(service: &ScratchpadService) -> ListResult {
        info!("Handling SCRATCHPAD_LIST action");

        let entries = service.list().await;

        if entries.is_empty() {
            return ListResult {
                success: true,
                text: "You don't have any scratchpad entries yet. Use SCRATCHPAD_WRITE to create one.".to_string(),
                entries: Vec::new(),
            };
        }

        let lines: Vec<String> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let tags_str = if !e.tags.is_empty() {
                    format!(" [{}]", e.tags.join(", "))
                } else {
                    String::new()
                };
                format!(
                    "{}. **{}** ({}){}\n   _Modified: {}_",
                    i + 1,
                    e.title,
                    e.id,
                    tags_str,
                    e.modified_at.format("%Y-%m-%d")
                )
            })
            .collect();

        let list_text = lines.join("\n");
        let text = format!(
            "**Your Scratchpad Entries** ({} total):\n\n{}",
            entries.len(),
            list_text
        );

        ListResult {
            success: true,
            text,
            entries,
        }
    }
}
