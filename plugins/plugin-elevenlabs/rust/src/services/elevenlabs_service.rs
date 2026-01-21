//! ElevenLabs service for TTS and STT operations.

use std::env;

use bytes::Bytes;
use futures::StreamExt;
use reqwest::multipart::{Form, Part};
use tokio_stream::Stream;

use crate::types::{
    ElevenLabsError, ElevenLabsSTTOptions, ElevenLabsTTSOptions, STTResponse, TTSRequest,
    VoiceSettings,
};

/// Service for interacting with the ElevenLabs API.
///
/// Provides high-quality text-to-speech (TTS) and speech-to-text (STT) capabilities.
pub struct ElevenLabsService {
    client: reqwest::Client,
    api_key: String,
    tts_options: ElevenLabsTTSOptions,
    stt_options: ElevenLabsSTTOptions,
}

impl ElevenLabsService {
    /// Base URL for the ElevenLabs API.
    pub const BASE_URL: &'static str = "https://api.elevenlabs.io/v1";

    /// Create a new ElevenLabs service with the given API key.
    ///
    /// # Arguments
    ///
    /// * `api_key` - ElevenLabs API key
    pub fn new(api_key: impl Into<String>) -> Self {
        let api_key = api_key.into();
        Self {
            client: reqwest::Client::new(),
            api_key: api_key.clone(),
            tts_options: Self::get_tts_options_from_env(&api_key),
            stt_options: Self::get_stt_options_from_env(&api_key),
        }
    }

    /// Create a new ElevenLabs service with custom options.
    ///
    /// # Arguments
    ///
    /// * `api_key` - ElevenLabs API key
    /// * `tts_options` - Text-to-speech options
    /// * `stt_options` - Speech-to-text options
    pub fn with_options(
        api_key: impl Into<String>,
        tts_options: ElevenLabsTTSOptions,
        stt_options: ElevenLabsSTTOptions,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: api_key.into(),
            tts_options,
            stt_options,
        }
    }

    /// Create a new ElevenLabs service from environment variables.
    pub fn from_env() -> Result<Self, ElevenLabsError> {
        let api_key = env::var("ELEVENLABS_API_KEY").map_err(|_| ElevenLabsError::MissingApiKey)?;
        Ok(Self::new(api_key))
    }

    fn get_tts_options_from_env(api_key: &str) -> ElevenLabsTTSOptions {
        ElevenLabsTTSOptions {
            api_key: api_key.to_string(),
            voice_id: env::var("ELEVENLABS_VOICE_ID")
                .unwrap_or_else(|_| "EXAVITQu4vr4xnSDxMaL".to_string()),
            model_id: env::var("ELEVENLABS_MODEL_ID")
                .unwrap_or_else(|_| "eleven_monolingual_v1".to_string()),
            output_format: env::var("ELEVENLABS_OUTPUT_FORMAT")
                .unwrap_or_else(|_| "mp3_44100_128".to_string()),
            optimize_streaming_latency: env::var("ELEVENLABS_OPTIMIZE_STREAMING_LATENCY")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            voice_settings: VoiceSettings {
                stability: env::var("ELEVENLABS_VOICE_STABILITY")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.5),
                similarity_boost: env::var("ELEVENLABS_VOICE_SIMILARITY_BOOST")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.75),
                style: env::var("ELEVENLABS_VOICE_STYLE")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.0),
                use_speaker_boost: env::var("ELEVENLABS_VOICE_USE_SPEAKER_BOOST")
                    .map(|v| v.to_lowercase() == "true")
                    .unwrap_or(true),
            },
        }
    }

    fn get_stt_options_from_env(api_key: &str) -> ElevenLabsSTTOptions {
        use crate::types::TranscriptionSettings;

        ElevenLabsSTTOptions {
            api_key: api_key.to_string(),
            model_id: env::var("ELEVENLABS_STT_MODEL_ID")
                .unwrap_or_else(|_| "scribe_v1".to_string()),
            language_code: env::var("ELEVENLABS_STT_LANGUAGE_CODE").ok(),
            transcription_settings: TranscriptionSettings {
                timestamps_granularity: env::var("ELEVENLABS_STT_TIMESTAMPS_GRANULARITY")
                    .unwrap_or_else(|_| "word".to_string()),
                diarize: env::var("ELEVENLABS_STT_DIARIZE")
                    .map(|v| v.to_lowercase() == "true")
                    .unwrap_or(false),
                num_speakers: env::var("ELEVENLABS_STT_NUM_SPEAKERS")
                    .ok()
                    .and_then(|v| v.parse().ok()),
                tag_audio_events: env::var("ELEVENLABS_STT_TAG_AUDIO_EVENTS")
                    .map(|v| v.to_lowercase() == "true")
                    .unwrap_or(false),
            },
        }
    }

    /// Get the API key.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    /// Get TTS options.
    pub fn tts_options(&self) -> &ElevenLabsTTSOptions {
        &self.tts_options
    }

    /// Get STT options.
    pub fn stt_options(&self) -> &ElevenLabsSTTOptions {
        &self.stt_options
    }

    /// Convert text to speech using ElevenLabs API.
    ///
    /// Returns the complete audio data as bytes.
    ///
    /// # Arguments
    ///
    /// * `text` - The text to convert to speech
    ///
    /// # Returns
    ///
    /// Audio data as bytes.
    pub async fn text_to_speech(&self, text: &str) -> Result<Bytes, ElevenLabsError> {
        self.text_to_speech_with_options(text, None, None, None, None)
            .await
    }

    /// Convert text to speech with custom options.
    ///
    /// # Arguments
    ///
    /// * `text` - The text to convert to speech
    /// * `voice_id` - Voice ID to use (optional, uses configured default)
    /// * `model_id` - Model ID to use (optional, uses configured default)
    /// * `output_format` - Output format (optional, uses configured default)
    /// * `voice_settings` - Voice settings (optional, uses configured default)
    pub async fn text_to_speech_with_options(
        &self,
        text: &str,
        voice_id: Option<&str>,
        model_id: Option<&str>,
        output_format: Option<&str>,
        voice_settings: Option<&VoiceSettings>,
    ) -> Result<Bytes, ElevenLabsError> {
        let resolved_voice_id = voice_id.unwrap_or(&self.tts_options.voice_id);
        let resolved_model_id = model_id.unwrap_or(&self.tts_options.model_id);
        let resolved_format = output_format.unwrap_or(&self.tts_options.output_format);
        let resolved_settings = voice_settings.unwrap_or(&self.tts_options.voice_settings);

        let url = format!(
            "{}/text-to-speech/{}/stream",
            Self::BASE_URL,
            resolved_voice_id
        );

        let request = TTSRequest {
            text: text.to_string(),
            model_id: resolved_model_id.to_string(),
            output_format: resolved_format.to_string(),
            voice_settings: resolved_settings.clone(),
        };

        let response = self
            .client
            .post(&url)
            .header("xi-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ElevenLabsError::Api(format!("HTTP {}: {}", status, body)));
        }

        let bytes = response.bytes().await?;
        Ok(bytes)
    }

    /// Convert text to speech and return a stream of audio chunks.
    ///
    /// # Arguments
    ///
    /// * `text` - The text to convert to speech
    ///
    /// # Returns
    ///
    /// A stream of audio data chunks.
    pub async fn text_to_speech_stream(
        &self,
        text: &str,
    ) -> Result<impl Stream<Item = Result<Bytes, ElevenLabsError>>, ElevenLabsError> {
        let url = format!(
            "{}/text-to-speech/{}/stream",
            Self::BASE_URL,
            self.tts_options.voice_id
        );

        let request = TTSRequest {
            text: text.to_string(),
            model_id: self.tts_options.model_id.clone(),
            output_format: self.tts_options.output_format.clone(),
            voice_settings: self.tts_options.voice_settings.clone(),
        };

        let response = self
            .client
            .post(&url)
            .header("xi-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ElevenLabsError::Api(format!("HTTP {}: {}", status, body)));
        }

        Ok(response
            .bytes_stream()
            .map(|result| result.map_err(ElevenLabsError::from)))
    }

    /// Convert speech to text using ElevenLabs API.
    ///
    /// # Arguments
    ///
    /// * `audio` - Audio data as bytes
    ///
    /// # Returns
    ///
    /// Transcribed text.
    pub async fn speech_to_text(&self, audio: &[u8]) -> Result<String, ElevenLabsError> {
        self.speech_to_text_with_options(audio, None, None).await
    }

    /// Convert speech to text with custom options.
    ///
    /// # Arguments
    ///
    /// * `audio` - Audio data as bytes
    /// * `model_id` - Model ID to use (optional, uses configured default)
    /// * `language_code` - Language code (optional, auto-detect if not set)
    pub async fn speech_to_text_with_options(
        &self,
        audio: &[u8],
        model_id: Option<&str>,
        language_code: Option<&str>,
    ) -> Result<String, ElevenLabsError> {
        let resolved_model_id = model_id.unwrap_or(&self.stt_options.model_id);
        let resolved_language = language_code.or(self.stt_options.language_code.as_deref());
        let settings = &self.stt_options.transcription_settings;

        let url = format!("{}/speech-to-text", Self::BASE_URL);

        let audio_part = Part::bytes(audio.to_vec())
            .file_name("audio.mp3")
            .mime_str("audio/mpeg")?;

        let mut form = Form::new()
            .part("audio", audio_part)
            .text("model_id", resolved_model_id.to_string());

        if let Some(lang) = resolved_language {
            form = form.text("language_code", lang.to_string());
        }

        if settings.timestamps_granularity != "none" {
            form = form.text(
                "timestamps_granularity",
                settings.timestamps_granularity.clone(),
            );
        }

        if settings.diarize {
            form = form.text("diarize", "true".to_string());
            if let Some(num) = settings.num_speakers {
                form = form.text("num_speakers", num.to_string());
            }
        }

        if settings.tag_audio_events {
            form = form.text("tag_audio_events", "true".to_string());
        }

        let response = self
            .client
            .post(&url)
            .header("xi-api-key", &self.api_key)
            .multipart(form)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ElevenLabsError::Api(format!("HTTP {}: {}", status, body)));
        }

        let result: STTResponse = response.json().await?;

        // Extract transcript from response
        if let Some(text) = result.text {
            return Ok(text);
        }

        if let Some(transcript) = result.transcript {
            if let Some(text) = transcript.text {
                return Ok(text);
            }
        }

        if let Some(transcripts) = result.transcripts {
            let texts: Vec<String> = transcripts.into_iter().filter_map(|t| t.text).collect();
            return Ok(texts.join("\n"));
        }

        Ok(String::new())
    }
}
