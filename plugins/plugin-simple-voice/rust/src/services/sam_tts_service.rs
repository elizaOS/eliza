#![allow(missing_docs)]

use std::sync::Arc;
use tracing::info;

use crate::sam_engine::SamEngine;
use crate::types::{HardwareBridge, SamTTSOptions, SAM_SERVICE_TYPE};

pub trait Runtime: Send + Sync {
    fn get_service(&self, service_type: &str) -> Option<Arc<dyn HardwareBridge>>;
}

pub struct SamTTSService {
    runtime: Option<Arc<dyn Runtime>>,
}

impl SamTTSService {
    pub const SERVICE_TYPE: &'static str = SAM_SERVICE_TYPE;

    pub fn new(runtime: Option<Arc<dyn Runtime>>) -> Self {
        Self { runtime }
    }

    pub async fn start(runtime: Arc<dyn Runtime>) -> Self {
        info!("[SAM-TTS] Service initialized");
        Self::new(Some(runtime))
    }

    pub async fn stop(&self) {
        info!("[SAM-TTS] Service stopped");
    }

    pub fn generate_audio(&self, text: &str, options: Option<SamTTSOptions>) -> Vec<u8> {
        let opts = options.unwrap_or_default();

        info!(
            "[SAM-TTS] Synthesizing: \"{}{}\"",
            &text[..text.len().min(50)],
            if text.len() > 50 { "..." } else { "" }
        );

        let sam = SamEngine::new(opts);
        let audio = sam.buf8(text);

        info!("[SAM-TTS] Generated {} bytes", audio.len());
        audio
    }

    pub async fn speak_text(&self, text: &str, options: Option<SamTTSOptions>) -> Vec<u8> {
        let audio = self.generate_audio(text, options);
        let wav = self.create_wav_buffer(&audio, 22050);

        if let Some(ref rt) = self.runtime {
            if let Some(bridge) = rt.get_service("hardwareBridge") {
                info!("[SAM-TTS] Sending to hardware bridge...");
                let _ = bridge.send_audio_data(&wav).await;
                info!("[SAM-TTS] Audio sent");
            }
        }

        audio
    }

    pub fn create_wav_buffer(&self, audio_data: &[u8], sample_rate: u32) -> Vec<u8> {
        let data_size = audio_data.len() as u32;
        let mut buffer = Vec::with_capacity(44 + audio_data.len());

        buffer.extend_from_slice(b"RIFF");
        buffer.extend_from_slice(&(36 + data_size).to_le_bytes());
        buffer.extend_from_slice(b"WAVE");
        buffer.extend_from_slice(b"fmt ");
        buffer.extend_from_slice(&16u32.to_le_bytes());
        buffer.extend_from_slice(&1u16.to_le_bytes());
        buffer.extend_from_slice(&1u16.to_le_bytes());
        buffer.extend_from_slice(&sample_rate.to_le_bytes());
        buffer.extend_from_slice(&sample_rate.to_le_bytes());
        buffer.extend_from_slice(&1u16.to_le_bytes());
        buffer.extend_from_slice(&8u16.to_le_bytes());
        buffer.extend_from_slice(b"data");
        buffer.extend_from_slice(&data_size.to_le_bytes());
        buffer.extend_from_slice(audio_data);

        buffer
    }

    pub fn capability_description(&self) -> &'static str {
        "SAM TTS: Retro 1980s text-to-speech synthesis"
    }
}

impl Default for SamTTSService {
    fn default() -> Self {
        Self::new(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_correct_type() {
        assert_eq!(SamTTSService::SERVICE_TYPE, "SAM_TTS");
    }

    #[tokio::test]
    async fn generates_audio() {
        let service = SamTTSService::default();
        let audio = service.generate_audio("Hello", None);
        assert!(!audio.is_empty());
    }

    #[test]
    fn creates_wav_buffer() {
        let service = SamTTSService::default();
        let audio = service.generate_audio("Test", None);
        let wav = service.create_wav_buffer(&audio, 22050);

        assert_eq!(wav.len(), audio.len() + 44);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }
}
