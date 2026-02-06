//! Send media action for WhatsApp plugin.

use crate::client::WhatsAppClientError;
use crate::service::WhatsAppService;
use crate::types::WhatsAppMessageResponse;
use tracing::info;

/// Action name.
pub const SEND_MEDIA_ACTION: &str = "WHATSAPP_SEND_MEDIA";

/// Media type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Image,
    Video,
    Audio,
    Document,
}

impl MediaType {
    /// Parse from string.
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_lowercase().as_str() {
            "image" => Ok(MediaType::Image),
            "video" => Ok(MediaType::Video),
            "audio" => Ok(MediaType::Audio),
            "document" | "doc" => Ok(MediaType::Document),
            _ => Err(format!("Invalid media type: {}", s)),
        }
    }

    /// Get string representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaType::Image => "image",
            MediaType::Video => "video",
            MediaType::Audio => "audio",
            MediaType::Document => "document",
        }
    }
}

/// Parameters for sending a WhatsApp media message.
#[derive(Debug, Clone)]
pub struct SendMediaParams {
    /// Recipient phone number.
    pub to: String,
    /// Media type.
    pub media_type: MediaType,
    /// Media URL.
    pub url: String,
    /// Optional caption.
    pub caption: Option<String>,
    /// Optional filename (for documents).
    pub filename: Option<String>,
}

impl SendMediaParams {
    /// Create new media parameters.
    pub fn new(to: impl Into<String>, media_type: MediaType, url: impl Into<String>) -> Self {
        Self {
            to: to.into(),
            media_type,
            url: url.into(),
            caption: None,
            filename: None,
        }
    }

    /// Set the caption.
    pub fn with_caption(mut self, caption: impl Into<String>) -> Self {
        self.caption = Some(caption.into());
        self
    }

    /// Set the filename.
    pub fn with_filename(mut self, filename: impl Into<String>) -> Self {
        self.filename = Some(filename.into());
        self
    }
}

/// Validate media parameters.
pub fn validate(params: &SendMediaParams) -> Result<(), String> {
    if params.to.is_empty() {
        return Err("Recipient phone number is required".to_string());
    }
    if params.url.is_empty() {
        return Err("Media URL is required".to_string());
    }
    Ok(())
}

/// Execute the send media action.
pub async fn execute_send_media(
    service: &WhatsAppService,
    params: SendMediaParams,
) -> Result<WhatsAppMessageResponse, WhatsAppClientError> {
    validate(&params).map_err(|e| WhatsAppClientError::Config(e))?;

    let response = match params.media_type {
        MediaType::Image => {
            service
                .send_image(&params.to, &params.url, params.caption.as_deref())
                .await?
        }
        MediaType::Video => {
            service
                .send_video(&params.to, &params.url, params.caption.as_deref())
                .await?
        }
        MediaType::Audio => service.send_audio(&params.to, &params.url).await?,
        MediaType::Document => {
            service
                .send_document(
                    &params.to,
                    &params.url,
                    params.filename.as_deref(),
                    params.caption.as_deref(),
                )
                .await?
        }
    };

    info!(
        "Sent WhatsApp {} to {}, message_id={}",
        params.media_type.as_str(),
        params.to,
        response.messages.first().map(|m| &m.id).unwrap_or(&"unknown".to_string())
    );

    Ok(response)
}
