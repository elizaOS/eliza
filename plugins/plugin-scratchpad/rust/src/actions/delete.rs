#![allow(missing_docs)]
//! SCRATCHPAD_DELETE action – delete a scratchpad entry.

use crate::service::ScratchpadService;
use tracing::{error, info};

/// Result of the delete action.
pub struct DeleteResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
}

/// SCRATCHPAD_DELETE action.
pub struct ScratchpadDeleteAction;

impl ScratchpadDeleteAction {
    /// Action name.
    pub const NAME: &'static str = "SCRATCHPAD_DELETE";

    /// Action description.
    pub const DESCRIPTION: &'static str = "Delete a scratchpad entry by its ID.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SCRATCHPAD_DELETE",
        "DELETE_NOTE",
        "REMOVE_NOTE",
        "ERASE_NOTE",
        "REMOVE_FROM_SCRATCHPAD",
    ];

    /// Handle the delete action.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    /// * `entry_id` - ID of the entry to delete
    pub async fn handle(service: &ScratchpadService, entry_id: &str) -> DeleteResult {
        info!("Handling SCRATCHPAD_DELETE action for {}", entry_id);

        if entry_id.trim().is_empty() {
            return DeleteResult {
                success: false,
                text: "Entry ID is required.".to_string(),
            };
        }

        match service.delete(entry_id).await {
            Ok(true) => DeleteResult {
                success: true,
                text: format!(
                    "Successfully deleted scratchpad entry \"{}\".",
                    entry_id
                ),
            },
            Ok(false) => DeleteResult {
                success: false,
                text: format!("Scratchpad entry \"{}\" not found.", entry_id),
            },
            Err(e) => {
                error!("[ScratchpadDelete] Error: {}", e);
                DeleteResult {
                    success: false,
                    text: format!("Failed to delete the note: {}", e),
                }
            }
        }
    }
}
