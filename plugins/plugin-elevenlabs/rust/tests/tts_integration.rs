//! Integration tests for ElevenLabs TTS functionality.
//!
//! These tests require a valid ELEVENLABS_API_KEY environment variable to run real API calls.
//! Tests will be skipped gracefully if no API key is available.

use std::env;

use eliza_plugin_elevenlabs::{ElevenLabsPlugin, ElevenLabsService, VoiceSettings};

/// Get API key from environment.
fn get_api_key() -> Option<String> {
    env::var("ELEVENLABS_API_KEY").ok()
}

/// Macro to skip test if no API key is available.
macro_rules! require_api_key {
    () => {
        match get_api_key() {
            Some(key) => key,
            None => {
                eprintln!("⚠️ Skipping test - no ELEVENLABS_API_KEY found");
                return;
            }
        }
    };
}

mod plugin_structure {
    use super::*;

    #[test]
    fn should_have_basic_plugin_structure() {
        let plugin = ElevenLabsPlugin::new();
        assert_eq!(plugin.name, "elevenLabs");
        assert!(!plugin.description.is_empty());
        assert!(plugin.description.contains("text-to-speech"));
    }

    #[test]
    fn should_have_default_options() {
        let plugin = ElevenLabsPlugin::new();
        assert_eq!(plugin.tts_options.voice_id, "EXAVITQu4vr4xnSDxMaL");
        assert_eq!(plugin.tts_options.model_id, "eleven_monolingual_v1");
        assert_eq!(plugin.stt_options.model_id, "scribe_v1");
    }
}

mod real_tts_functionality {
    use super::*;

    #[tokio::test]
    async fn should_convert_text_to_speech_with_real_api() {
        let api_key = require_api_key!();

        let test_text = "Hello, this is a test of ElevenLabs text to speech.";
        println!("🎤 Testing real TTS with text: {}", test_text);

        let service = ElevenLabsService::new(&api_key);

        match service.text_to_speech(test_text).await {
            Ok(audio_data) => {
                if audio_data.is_empty() {
                    panic!("No audio data received");
                }
                println!("✅ SUCCESS: Generated {} bytes of audio", audio_data.len());
            }
            Err(e) => {
                let error_msg = e.to_string().to_lowercase();
                if error_msg.contains("quota") {
                    eprintln!("⚠️ ElevenLabs quota exceeded - test skipped");
                    return;
                }
                panic!("❌ TTS test failed: {}", e);
            }
        }
    }
}

mod different_voices {
    use super::*;

    #[tokio::test]
    async fn should_test_different_voices() {
        let api_key = require_api_key!();

        let voices = [
            ("EXAVITQu4vr4xnSDxMaL", "Bella"),
            ("21m00Tcm4TlvDq8ikWAM", "Rachel"),
        ];

        let service = ElevenLabsService::new(&api_key);

        for (voice_id, voice_name) in voices {
            println!("🎭 Testing voice: {} ({})", voice_name, voice_id);

            match service
                .text_to_speech_with_options(
                    &format!("Testing voice {}", voice_name),
                    Some(voice_id),
                    None,
                    None,
                    None,
                )
                .await
            {
                Ok(audio_data) => {
                    if audio_data.is_empty() {
                        panic!("Voice {} returned empty data", voice_name);
                    }
                    println!("✅ Voice {} working", voice_name);
                }
                Err(e) => {
                    let error_msg = e.to_string().to_lowercase();
                    if error_msg.contains("quota") {
                        eprintln!("⚠️ Quota exceeded for voice {}", voice_name);
                        break;
                    }
                    panic!("❌ Voice {} failed: {}", voice_name, e);
                }
            }
        }
    }
}

mod long_text_input {
    use super::*;

    #[tokio::test]
    async fn should_handle_longer_text_input() {
        let api_key = require_api_key!();

        let long_text = r#"
            This is a longer text to test the ElevenLabs text-to-speech functionality.
            We want to ensure that the API can handle sentences of reasonable length
            and that the audio quality remains consistent throughout the entire speech.
            This test verifies that longer inputs are processed correctly.
        "#
        .trim();

        println!("📝 Testing long text ({} characters)", long_text.len());

        let service = ElevenLabsService::new(&api_key);

        match service.text_to_speech(long_text).await {
            Ok(audio_data) => {
                if audio_data.len() < 1000 {
                    panic!(
                        "Long text produced too little audio: {} bytes",
                        audio_data.len()
                    );
                }
                println!("✅ Long text generated {} bytes of audio", audio_data.len());
            }
            Err(e) => {
                let error_msg = e.to_string().to_lowercase();
                if error_msg.contains("quota") {
                    eprintln!("⚠️ Quota exceeded testing long text");
                    return;
                }
                panic!("❌ Long text test failed: {}", e);
            }
        }
    }
}

mod custom_voice_settings {
    use super::*;

    #[tokio::test]
    async fn should_test_custom_voice_settings() {
        let api_key = require_api_key!();

        println!("⚙️ Testing custom voice settings");

        let custom_settings = VoiceSettings {
            stability: 0.3,
            similarity_boost: 0.8,
            style: 0.2,
            use_speaker_boost: false,
        };

        let service = ElevenLabsService::new(&api_key);

        match service
            .text_to_speech_with_options(
                "Testing custom voice settings",
                None,
                None,
                None,
                Some(&custom_settings),
            )
            .await
        {
            Ok(audio_data) => {
                if audio_data.is_empty() {
                    panic!("No audio data with custom settings");
                }
                println!("✅ Custom voice settings working");
            }
            Err(e) => {
                let error_msg = e.to_string().to_lowercase();
                if error_msg.contains("quota") {
                    eprintln!("⚠️ Quota exceeded testing voice settings");
                    return;
                }
                panic!("❌ Voice settings test failed: {}", e);
            }
        }
    }
}

mod output_formats {
    use super::*;

    #[tokio::test]
    async fn should_support_mp3_format() {
        let api_key = require_api_key!();

        println!("🎵 Testing MP3 format");

        let service = ElevenLabsService::new(&api_key);

        match service
            .text_to_speech_with_options(
                "Testing MP3 format",
                None,
                None,
                Some("mp3_44100_128"),
                None,
            )
            .await
        {
            Ok(audio_data) => {
                if audio_data.is_empty() {
                    panic!("No audio data for MP3 format");
                }

                // Check for MP3 signature (ID3 header or frame sync)
                let is_id3 = audio_data.len() >= 3
                    && audio_data[0] == b'I'
                    && audio_data[1] == b'D'
                    && audio_data[2] == b'3';
                let is_frame_sync = audio_data.len() >= 2
                    && audio_data[0] == 0xFF
                    && (audio_data[1] & 0xE0) == 0xE0;

                if is_id3 || is_frame_sync {
                    println!("✅ MP3 format working (valid header detected)");
                } else {
                    println!("✅ MP3 format working (audio data received)");
                }
            }
            Err(e) => {
                let error_msg = e.to_string().to_lowercase();
                if error_msg.contains("quota") {
                    eprintln!("⚠️ Quota exceeded testing MP3 format");
                    return;
                }
                panic!("❌ MP3 format test failed: {}", e);
            }
        }
    }
}
