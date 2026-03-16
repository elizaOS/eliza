//! Edge TTS plugin definition for elizaOS.

use bytes::Bytes;

use crate::services::EdgeTTSService;
use crate::types::{EdgeTTSError, EdgeTTSParams, EdgeTTSSettings};

/// Edge TTS plugin for elizaOS.
///
/// Provides free text-to-speech synthesis using Microsoft Edge's TTS service.
/// No API key required - uses the same TTS engine as Microsoft Edge browser.
///
/// # Features
///
/// - High-quality neural voices
/// - Multiple languages and locales
/// - Adjustable rate, pitch, and volume
/// - No API key or payment required
/// - Voice presets compatible with OpenAI voice names
pub struct EdgeTTSPlugin {
    /// Plugin name.
    pub name: String,
    /// Plugin description.
    pub description: String,
    /// TTS settings.
    pub settings: EdgeTTSSettings,
    service: Option<EdgeTTSService>,
}

impl Default for EdgeTTSPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl EdgeTTSPlugin {
    /// Create a new Edge TTS plugin with default settings.
    pub fn new() -> Self {
        Self {
            name: "edge-tts".to_string(),
            description: "Free text-to-speech synthesis using Microsoft Edge TTS - \
                no API key required, high-quality neural voices"
                .to_string(),
            settings: EdgeTTSSettings::default(),
            service: None,
        }
    }

    /// Create a new Edge TTS plugin with custom settings.
    ///
    /// # Arguments
    ///
    /// * `settings` - Edge TTS configuration settings
    pub fn with_settings(settings: EdgeTTSSettings) -> Self {
        Self {
            name: "edge-tts".to_string(),
            description: "Free text-to-speech synthesis using Microsoft Edge TTS - \
                no API key required, high-quality neural voices"
                .to_string(),
            settings,
            service: None,
        }
    }

    /// Get or create the Edge TTS service instance.
    fn service(&mut self) -> &EdgeTTSService {
        if self.service.is_none() {
            self.service = Some(EdgeTTSService::with_settings(self.settings.clone()));
        }
        self.service.as_ref().unwrap()
    }

    /// Convert text to speech.
    ///
    /// # Arguments
    ///
    /// * `text` - The text to convert to speech
    ///
    /// # Returns
    ///
    /// Audio data as bytes.
    pub async fn text_to_speech(&mut self, text: &str) -> Result<Bytes, EdgeTTSError> {
        self.service().text_to_speech(text).await
    }

    /// Convert text to speech with custom parameters.
    ///
    /// # Arguments
    ///
    /// * `params` - Edge TTS parameters
    ///
    /// # Returns
    ///
    /// Audio data as bytes.
    pub async fn text_to_speech_with_params(
        &mut self,
        params: &EdgeTTSParams,
    ) -> Result<Bytes, EdgeTTSError> {
        self.service().text_to_speech_with_params(params).await
    }
}
