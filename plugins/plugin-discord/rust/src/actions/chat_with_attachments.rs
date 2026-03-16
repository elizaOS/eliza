//! Chat with attachments action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to summarize and interact with attachments in Discord messages
pub struct ChatWithAttachmentsAction;

#[async_trait]
impl DiscordAction for ChatWithAttachmentsAction {
    fn name(&self) -> &str {
        "CHAT_WITH_ATTACHMENTS"
    }

    fn description(&self) -> &str {
        "Answer a user request informed by specific attachments based on their IDs. \
        If a user asks to chat with a PDF, or wants more specific information about \
        a link or video or anything else they've attached, this is the action to use."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "CHAT_WITH_ATTACHMENT",
            "SUMMARIZE_FILES",
            "SUMMARIZE_FILE",
            "SUMMARIZE_ATTACHMENT",
            "CHAT_WITH_PDF",
            "ATTACHMENT_SUMMARY",
            "RECAP_ATTACHMENTS",
            "SUMMARIZE_VIDEO",
            "SUMMARIZE_AUDIO",
            "SUMMARIZE_IMAGE",
            "SUMMARIZE_DOCUMENT",
            "SUMMARIZE_LINK",
            "FILE_SUMMARY",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if source != "discord" {
            return Ok(false);
        }

        // Check for relevant keywords
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let keywords = [
            "attachment",
            "summary",
            "summarize",
            "research",
            "pdf",
            "video",
            "audio",
            "image",
            "document",
            "link",
            "file",
            "code",
            "report",
            "write",
            "details",
            "information",
            "talk",
            "chat",
            "read",
            "listen",
            "watch",
        ];

        Ok(keywords.iter().any(|k| text.contains(k)))
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let attachments = context
            .message
            .get("content")
            .and_then(|c| c.get("attachments"))
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();

        if attachments.is_empty() {
            return Ok(ActionResult::failure(
                "No attachments found in the conversation to analyze.",
            ));
        }

        // Extract text content from attachments
        let mut attachment_summaries = Vec::new();
        for attachment in &attachments {
            if let Some(obj) = attachment.as_object() {
                let title = obj
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("Untitled");
                let att_text = obj.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if !att_text.is_empty() {
                    attachment_summaries.push(format!("# {}\n{}", title, att_text));
                }
            }
        }

        if attachment_summaries.is_empty() {
            return Ok(ActionResult::failure(
                "Could not extract text content from the attachments.",
            ));
        }

        let attachments_content = attachment_summaries.join("\n\n");
        let summary = service.generate_summary(&attachments_content, text).await?;

        if summary.is_empty() {
            Ok(ActionResult::failure("Failed to generate summary."))
        } else {
            Ok(ActionResult::success_with_data(
                summary,
                serde_json::json!({
                    "attachment_count": attachments.len(),
                    "objective": text,
                }),
            ))
        }
    }
}
