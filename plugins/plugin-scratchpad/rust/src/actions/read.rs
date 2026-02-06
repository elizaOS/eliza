#![allow(missing_docs)]
//! SCRATCHPAD_READ action – read a specific scratchpad entry by ID.

use crate::service::ScratchpadService;
use crate::types::{ScratchpadEntry, ScratchpadReadOptions};
use tracing::{error, info};

/// Result of the read action.
pub struct ReadResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
    /// The read entry if successful.
    pub entry: Option<ScratchpadEntry>,
}

/// SCRATCHPAD_READ action.
pub struct ScratchpadReadAction;

impl ScratchpadReadAction {
    /// Action name.
    pub const NAME: &'static str = "SCRATCHPAD_READ";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Read a specific scratchpad entry by its ID, with optional line range.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SCRATCHPAD_READ",
        "READ_NOTE",
        "GET_NOTE",
        "VIEW_NOTE",
        "SHOW_NOTE",
        "OPEN_SCRATCHPAD",
    ];

    /// Handle the read action.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    /// * `entry_id` - ID of the entry to read
    /// * `options` - Read options (line range)
    pub async fn handle(
        service: &ScratchpadService,
        entry_id: &str,
        options: &ScratchpadReadOptions,
    ) -> ReadResult {
        info!("Handling SCRATCHPAD_READ action for {}", entry_id);

        if entry_id.trim().is_empty() {
            return ReadResult {
                success: false,
                text: "Entry ID is required.".to_string(),
                entry: None,
            };
        }

        match service.read(entry_id, options).await {
            Ok(entry) => {
                let line_info = match options.from {
                    Some(from) => {
                        let end = from + options.lines.unwrap_or(10);
                        format!(" (lines {}-{})", from, end)
                    }
                    None => String::new(),
                };

                let text = format!("**{}**{}\n\n{}", entry.title, line_info, entry.content);

                ReadResult {
                    success: true,
                    text,
                    entry: Some(entry),
                }
            }
            Err(e) => {
                error!("[ScratchpadRead] Error: {}", e);
                ReadResult {
                    success: false,
                    text: format!("Failed to read the note: {}", e),
                    entry: None,
                }
            }
        }
    }
}
