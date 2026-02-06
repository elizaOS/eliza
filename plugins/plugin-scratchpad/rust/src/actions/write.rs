#![allow(missing_docs)]
//! SCRATCHPAD_WRITE action – create a new scratchpad entry.

use crate::service::ScratchpadService;
use crate::types::ScratchpadWriteOptions;
use tracing::{error, info};

/// Result of the write action.
pub struct WriteResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
    /// Created entry ID if successful.
    pub entry_id: Option<String>,
}

/// SCRATCHPAD_WRITE action.
pub struct ScratchpadWriteAction;

impl ScratchpadWriteAction {
    /// Action name.
    pub const NAME: &'static str = "SCRATCHPAD_WRITE";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Create a new scratchpad entry with a title, content, and optional tags.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SCRATCHPAD_WRITE",
        "SAVE_NOTE",
        "WRITE_NOTE",
        "REMEMBER_THIS",
        "SAVE_TO_SCRATCHPAD",
        "JOT_DOWN",
    ];

    /// Handle the write action.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    /// * `title` - Note title
    /// * `content` - Note content
    /// * `tags` - Optional tags
    pub async fn handle(
        service: &ScratchpadService,
        title: &str,
        content: &str,
        tags: Option<Vec<String>>,
    ) -> WriteResult {
        info!("Handling SCRATCHPAD_WRITE action");

        if title.trim().is_empty() || content.trim().is_empty() {
            return WriteResult {
                success: false,
                text: "Title and content are required to create a note.".to_string(),
                entry_id: None,
            };
        }

        let options = ScratchpadWriteOptions {
            tags: tags.clone(),
            append: false,
        };

        match service.write(title, content, &options).await {
            Ok(entry) => {
                let tags_text = if !entry.tags.is_empty() {
                    format!(" Tags: {}", entry.tags.join(", "))
                } else {
                    String::new()
                };

                let text = format!(
                    "I've saved a note titled \"{}\" (ID: {}).{} You can retrieve it later using the ID or by searching for it.",
                    entry.title, entry.id, tags_text
                );

                WriteResult {
                    success: true,
                    text,
                    entry_id: Some(entry.id),
                }
            }
            Err(e) => {
                error!("[ScratchpadWrite] Error: {}", e);
                WriteResult {
                    success: false,
                    text: format!("Failed to save the note: {}", e),
                    entry_id: None,
                }
            }
        }
    }
}
