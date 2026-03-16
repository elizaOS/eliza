//! Download media action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::types::Snowflake;
use crate::DiscordService;

/// Action to download video or audio from a URL
pub struct DownloadMediaAction;

#[async_trait]
impl DiscordAction for DownloadMediaAction {
    fn name(&self) -> &str {
        "DOWNLOAD_MEDIA"
    }

    fn description(&self) -> &str {
        "Downloads a video or audio file from a URL and attaches it to the response message."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "DOWNLOAD_VIDEO",
            "DOWNLOAD_AUDIO",
            "GET_MEDIA",
            "DOWNLOAD_PODCAST",
            "DOWNLOAD_YOUTUBE",
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
        let channel_id = Snowflake::new(context.channel_id.clone())?;

        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Extract URL from message
        let media_url = service.extract_media_url(text).await?;

        let media_url = match media_url {
            Some(url) => url,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't find a media URL in your message.",
                ))
            }
        };

        // Download the media
        let media_info = service.download_media(&media_url).await?;

        let media_info = match media_info {
            Some(info) => info,
            None => {
                return Ok(ActionResult::failure(
                    "Failed to download the media. The URL might be unsupported.",
                ))
            }
        };

        let title = media_info
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("Downloaded Media");
        let file_path = media_info
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("");

        // Send as attachment
        service
            .send_file(
                &channel_id,
                file_path,
                &format!(
                    "I downloaded the video \"{}\" and attached it below.",
                    title
                ),
            )
            .await?;

        Ok(ActionResult::success_with_data(
            format!("Successfully downloaded \"{}\".", title),
            serde_json::json!({
                "title": title,
                "path": file_path,
                "url": media_url,
            }),
        ))
    }
}
