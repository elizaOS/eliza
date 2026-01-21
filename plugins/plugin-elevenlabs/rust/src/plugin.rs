//! ElevenLabs plugin definition for ElizaOS.

use bytes::Bytes;

use crate::services::ElevenLabsService;
use crate::types::{ElevenLabsError, ElevenLabsSTTOptions, ElevenLabsTTSOptions};

/// ElevenLabs plugin for ElizaOS.
///
/// Provides high-quality text-to-speech (TTS) and speech-to-text (STT) capabilities
/// using the ElevenLabs API.
///
/// # Features
///
/// - High-quality voice synthesis (TTS)
/// - High-accuracy speech transcription (STT) with Scribe v1 model
/// - Support for multiple voice models and settings
/// - Configurable voice parameters (stability, similarity, style)
/// - Stream-based audio output for efficient memory usage
/// - Speaker diarization (up to 32 speakers)
/// - Multi-language support (99 languages for STT)
/// - Audio event detection (laughter, applause, etc.)
pub struct ElevenLabsPlugin {
    /// Plugin name.
    pub name: String,
    /// Plugin description.
    pub description: String,
    /// Text-to-speech options.
    pub tts_options: ElevenLabsTTSOptions,
    /// Speech-to-text options.
    pub stt_options: ElevenLabsSTTOptions,
    service: Option<ElevenLabsService>,
}

impl Default for ElevenLabsPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ElevenLabsPlugin {
    /// Create a new ElevenLabs plugin with default options.
    pub fn new() -> Self {
        Self {
            name: "elevenLabs".to_string(),
            description: "High-quality text-to-speech synthesis and speech-to-text transcription \
                using ElevenLabs API with support for multiple voices, languages, \
                and speaker diarization"
                .to_string(),
            tts_options: ElevenLabsTTSOptions::default(),
            stt_options: ElevenLabsSTTOptions::default(),
            service: None,
        }
    }

    /// Create a new ElevenLabs plugin with custom options.
    ///
    /// # Arguments
    ///
    /// * `tts_options` - Text-to-speech options
    /// * `stt_options` - Speech-to-text options
    pub fn with_options(
        tts_options: ElevenLabsTTSOptions,
        stt_options: ElevenLabsSTTOptions,
    ) -> Self {
        Self {
            name: "elevenLabs".to_string(),
            description: "High-quality text-to-speech synthesis and speech-to-text transcription \
                using ElevenLabs API with support for multiple voices, languages, \
                and speaker diarization"
                .to_string(),
            tts_options,
            stt_options,
            service: None,
        }
    }

    /// Get the ElevenLabs service instance.
    fn service(&mut self) -> &ElevenLabsService {
        if self.service.is_none() {
            let api_key = if !self.tts_options.api_key.is_empty() {
                &self.tts_options.api_key
            } else {
                &self.stt_options.api_key
            };

            self.service = Some(ElevenLabsService::with_options(
                api_key,
                self.tts_options.clone(),
                self.stt_options.clone(),
            ));
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
    pub async fn text_to_speech(&mut self, text: &str) -> Result<Bytes, ElevenLabsError> {
        self.service().text_to_speech(text).await
    }

    /// Convert speech to text.
    ///
    /// # Arguments
    ///
    /// * `audio` - Audio data as bytes
    ///
    /// # Returns
    ///
    /// Transcribed text.
    pub async fn speech_to_text(&mut self, audio: &[u8]) -> Result<String, ElevenLabsError> {
        self.service().speech_to_text(audio).await
    }
}
