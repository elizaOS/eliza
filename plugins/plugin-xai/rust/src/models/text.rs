//! Text generation model handlers using Grok.

use tracing::{debug, info};

use crate::grok::{GrokClient, TextGenerationParams};

/// Result of text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationResult {
    /// Whether generation succeeded.
    pub success: bool,
    /// Generated text.
    pub text: String,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Handler for TEXT_SMALL model using grok-3-mini.
pub struct TextSmallHandler;

impl TextSmallHandler {
    /// Model type identifier.
    pub const MODEL_TYPE: &'static str = "TEXT_SMALL";

    /// Model name in Grok API.
    pub const MODEL_NAME: &'static str = "grok-3-mini";

    /// Default max tokens.
    pub const DEFAULT_MAX_TOKENS: u32 = 1000;

    /// Handle text generation with the small model.
    ///
    /// # Arguments
    ///
    /// * `client` - The Grok client.
    /// * `prompt` - The prompt to generate from.
    /// * `max_tokens` - Optional maximum tokens.
    /// * `temperature` - Optional temperature (0.0-2.0).
    ///
    /// # Returns
    ///
    /// The generation result.
    pub async fn handle(
        client: &GrokClient,
        prompt: &str,
        max_tokens: Option<u32>,
        temperature: Option<f32>,
    ) -> TextGenerationResult {
        info!("TEXT_SMALL: Generating with prompt length {}", prompt.len());

        let params = TextGenerationParams::new(prompt)
            .max_tokens(max_tokens.unwrap_or(Self::DEFAULT_MAX_TOKENS))
            .temperature(temperature.unwrap_or(0.7));

        match client.generate_text(&params, false).await {
            Ok(response) => {
                debug!("TEXT_SMALL: Generated {} characters", response.text.len());
                TextGenerationResult {
                    success: true,
                    text: response.text,
                    error: None,
                }
            }
            Err(e) => TextGenerationResult {
                success: false,
                text: String::new(),
                error: Some(e.to_string()),
            },
        }
    }
}

/// Handler for TEXT_LARGE model using grok-3.
pub struct TextLargeHandler;

impl TextLargeHandler {
    /// Model type identifier.
    pub const MODEL_TYPE: &'static str = "TEXT_LARGE";

    /// Model name in Grok API.
    pub const MODEL_NAME: &'static str = "grok-3";

    /// Default max tokens.
    pub const DEFAULT_MAX_TOKENS: u32 = 4000;

    /// Handle text generation with the large model.
    ///
    /// # Arguments
    ///
    /// * `client` - The Grok client.
    /// * `prompt` - The prompt to generate from.
    /// * `max_tokens` - Optional maximum tokens.
    /// * `temperature` - Optional temperature (0.0-2.0).
    ///
    /// # Returns
    ///
    /// The generation result.
    pub async fn handle(
        client: &GrokClient,
        prompt: &str,
        max_tokens: Option<u32>,
        temperature: Option<f32>,
    ) -> TextGenerationResult {
        info!("TEXT_LARGE: Generating with prompt length {}", prompt.len());

        let params = TextGenerationParams::new(prompt)
            .max_tokens(max_tokens.unwrap_or(Self::DEFAULT_MAX_TOKENS))
            .temperature(temperature.unwrap_or(0.7));

        match client.generate_text(&params, true).await {
            Ok(response) => {
                debug!("TEXT_LARGE: Generated {} characters", response.text.len());
                TextGenerationResult {
                    success: true,
                    text: response.text,
                    error: None,
                }
            }
            Err(e) => TextGenerationResult {
                success: false,
                text: String::new(),
                error: Some(e.to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_small_metadata() {
        assert_eq!(TextSmallHandler::MODEL_TYPE, "TEXT_SMALL");
        assert_eq!(TextSmallHandler::MODEL_NAME, "grok-3-mini");
    }

    #[test]
    fn test_text_large_metadata() {
        assert_eq!(TextLargeHandler::MODEL_TYPE, "TEXT_LARGE");
        assert_eq!(TextLargeHandler::MODEL_NAME, "grok-3");
    }
}
