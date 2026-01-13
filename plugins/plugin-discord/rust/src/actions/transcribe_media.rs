//! Transcribe media action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to transcribe audio or video content
pub struct TranscribeMediaAction;

#[async_trait]
impl DiscordAction for TranscribeMediaAction {
    fn name(&self) -> &str {
        "TRANSCRIBE_MEDIA"
    }

    fn description(&self) -> &str {
        "Transcribe audio or video content from attachments or URLs into text."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "TRANSCRIBE_AUDIO",
            "TRANSCRIBE_VIDEO",
            "GET_TRANSCRIPT",
            "AUDIO_TO_TEXT",
            "VIDEO_TO_TEXT",
            "SPEECH_TO_TEXT",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        Ok(source == "discord")
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let content = context.message.get("content");

        let text = content
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let attachments = content
            .and_then(|c| c.get("attachments"))
            .and_then(|a| a.as_array())
            .map(|arr| arr.to_vec())
            .unwrap_or_default();

        // Try to find media to transcribe
        let mut media_url: Option<String> = None;

        // Check attachments first
        for attachment in &attachments {
            if let Some(obj) = attachment.as_object() {
                let content_type = obj
                    .get("content_type")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                if content_type.contains("audio") || content_type.contains("video") {
                    media_url = obj.get("url").and_then(|u| u.as_str()).map(String::from);
                    break;
                }
            }
        }

        // If no attachment, try to extract URL from message
        if media_url.is_none() {
            media_url = service.extract_media_url(text).await?;
        }

        let media_url = match media_url {
            Some(url) => url,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't find any audio or video to transcribe. \
                     Please attach a file or provide a URL.",
                ));
            }
        };

        // Transcribe the media
        let transcript = service.transcribe_media(&media_url).await?;

        if transcript.is_empty() {
            return Ok(ActionResult::failure(
                "I couldn't transcribe the media. The file format might not be supported.",
            ));
        }

        // Format response
        let response_text = if transcript.len() > 1500 {
            format!(
                "The transcript is quite long. Here's a preview:\n\n```\n{}...\n```\n\n*Full transcript has been saved.*",
                &transcript[..1000]
            )
        } else {
            format!("📝 **Transcript**\n\n```\n{}\n```", transcript)
        };

        Ok(ActionResult::success_with_data(
            response_text,
            serde_json::json!({
                "transcript": transcript,
                "url": media_url,
                "length": transcript.len(),
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate() {
        let action = TranscribeMediaAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "transcribe this audio",
                    "attachments": [{
                        "content_type": "audio/mp3",
                        "url": "https://example.com/audio.mp3"
                    }]
                }
            }),
            channel_id: "123456789".to_string(),
            guild_id: Some("987654321".to_string()),
            user_id: "111222333".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }
}
