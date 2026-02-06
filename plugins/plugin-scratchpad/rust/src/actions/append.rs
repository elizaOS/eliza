#![allow(missing_docs)]
//! SCRATCHPAD_APPEND action – append content to an existing scratchpad entry.

use crate::service::ScratchpadService;
use crate::types::{ScratchpadReadOptions, ScratchpadWriteOptions};
use tracing::{error, info};

/// Result of the append action.
pub struct AppendResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
}

/// SCRATCHPAD_APPEND action.
pub struct ScratchpadAppendAction;

impl ScratchpadAppendAction {
    /// Action name.
    pub const NAME: &'static str = "SCRATCHPAD_APPEND";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Append additional content to an existing scratchpad entry.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SCRATCHPAD_APPEND",
        "ADD_TO_NOTE",
        "APPEND_NOTE",
        "UPDATE_NOTE",
        "EXTEND_NOTE",
    ];

    /// Handle the append action.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    /// * `entry_id` - ID of the entry to append to
    /// * `content` - Content to append
    pub async fn handle(
        service: &ScratchpadService,
        entry_id: &str,
        content: &str,
    ) -> AppendResult {
        info!("Handling SCRATCHPAD_APPEND action for {}", entry_id);

        if entry_id.trim().is_empty() || content.trim().is_empty() {
            return AppendResult {
                success: false,
                text: "Entry ID and content are required.".to_string(),
            };
        }

        // Check if entry exists
        if !service.exists(entry_id).await {
            return AppendResult {
                success: false,
                text: format!("Scratchpad entry \"{}\" not found.", entry_id),
            };
        }

        // Read existing entry to get its title and tags
        let existing = match service
            .read(entry_id, &ScratchpadReadOptions::default())
            .await
        {
            Ok(e) => e,
            Err(e) => {
                error!("[ScratchpadAppend] Error reading entry: {}", e);
                return AppendResult {
                    success: false,
                    text: format!("Failed to read existing entry: {}", e),
                };
            }
        };

        let options = ScratchpadWriteOptions {
            append: true,
            tags: if existing.tags.is_empty() {
                None
            } else {
                Some(existing.tags)
            },
        };

        match service.write(&existing.title, content, &options).await {
            Ok(entry) => AppendResult {
                success: true,
                text: format!(
                    "Successfully appended content to \"{}\" ({}).",
                    entry.title, entry.id
                ),
            },
            Err(e) => {
                error!("[ScratchpadAppend] Error: {}", e);
                AppendResult {
                    success: false,
                    text: format!("Failed to append to the note: {}", e),
                }
            }
        }
    }
}
