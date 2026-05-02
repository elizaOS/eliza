//! Edge TTS plugin definition for ElizaOS.

use bytes::Bytes;

use crate::services::EdgeTTSService;
use crate::types::{EdgeTTSError, EdgeTTSParams, EdgeTTSSettings};

/// Free text-to-speech synthesis via Microsoft Edge TTS. No API key required.
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
    /// Create a plugin with default settings (voice from env or `en-US-MichelleNeural`).
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

    /// Create a plugin with explicit settings.
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

    fn service(&mut self) -> &EdgeTTSService {
        if self.service.is_none() {
            self.service = Some(EdgeTTSService::with_settings(self.settings.clone()));
        }
        self.service.as_ref().unwrap()
    }

    /// Synthesize speech from text using the plugin's default settings.
    pub async fn text_to_speech(&mut self, text: &str) -> Result<Bytes, EdgeTTSError> {
        self.service().text_to_speech(text).await
    }

    /// Synthesize speech with explicit per-call parameters.
    pub async fn text_to_speech_with_params(
        &mut self,
        params: &EdgeTTSParams,
    ) -> Result<Bytes, EdgeTTSError> {
        self.service().text_to_speech_with_params(params).await
    }
}
