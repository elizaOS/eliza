//! Integration tests for Edge TTS functionality.
//!
//! These tests make real requests to the Edge TTS service.
//! No API key is required - Edge TTS is free.
//! Tests will be skipped gracefully if network is unavailable.

use eliza_plugin_edge_tts::{EdgeTTSParams, EdgeTTSPlugin, EdgeTTSService, EdgeTTSSettings};

/// Check if a network error occurred (to skip test gracefully).
fn is_network_error(err: &eliza_plugin_edge_tts::EdgeTTSError) -> bool {
    let msg = err.to_string().to_lowercase();
    msg.contains("network")
        || msg.contains("connect")
        || msg.contains("dns")
        || msg.contains("resolve")
        || msg.contains("tls")
        || msg.contains("timeout")
}

mod plugin_structure {
    use super::*;

    #[test]
    fn should_have_basic_plugin_structure() {
        let plugin = EdgeTTSPlugin::new();
        assert_eq!(plugin.name, "edge-tts");
        assert!(!plugin.description.is_empty());
        assert!(plugin.description.contains("text-to-speech"));
    }

    #[test]
    fn should_have_default_settings() {
        let plugin = EdgeTTSPlugin::new();
        assert_eq!(plugin.settings.voice, "en-US-MichelleNeural");
        assert_eq!(plugin.settings.lang, "en-US");
        assert_eq!(
            plugin.settings.output_format,
            "audio-24khz-48kbitrate-mono-mp3"
        );
    }

    #[test]
    fn should_accept_custom_settings() {
        let settings = EdgeTTSSettings {
            voice: "en-US-GuyNeural".to_string(),
            rate: Some("+10%".to_string()),
            ..Default::default()
        };
        let plugin = EdgeTTSPlugin::with_settings(settings);
        assert_eq!(plugin.settings.voice, "en-US-GuyNeural");
        assert_eq!(plugin.settings.rate.as_deref(), Some("+10%"));
    }
}

mod input_validation {
    use super::*;

    #[tokio::test]
    async fn should_reject_empty_text() {
        let service = EdgeTTSService::new();
        let result = service.text_to_speech("").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[tokio::test]
    async fn should_reject_whitespace_only_text() {
        let service = EdgeTTSService::new();
        let result = service.text_to_speech("   ").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[tokio::test]
    async fn should_reject_too_long_text() {
        let service = EdgeTTSService::new();
        let long_text = "a".repeat(5001);
        let result = service.text_to_speech(&long_text).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("5000"));
    }

    #[tokio::test]
    async fn should_accept_max_length_text() {
        let service = EdgeTTSService::new();
        let max_text = "a".repeat(5000);
        // Should not return InvalidInput error (may still fail with network error)
        let result = service.text_to_speech(&max_text).await;
        match result {
            Ok(_) => {} // Success
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(ref e) => {
                // Should not be an InvalidInput error
                assert!(
                    !e.to_string().contains("5000"),
                    "5000 chars should be accepted"
                );
            }
        }
    }
}

mod real_tts_functionality {
    use super::*;

    #[tokio::test]
    async fn should_convert_text_to_speech() {
        let service = EdgeTTSService::new();
        let test_text = "Hello, this is a test of Edge TTS.";

        match service.text_to_speech(test_text).await {
            Ok(audio_data) => {
                assert!(!audio_data.is_empty(), "No audio data received");
                println!("SUCCESS: Generated {} bytes of audio", audio_data.len());

                // Check for MP3 header (ID3 tag or MPEG frame sync)
                let is_id3 =
                    audio_data.len() >= 3 && &audio_data[..3] == b"ID3";
                let is_frame_sync = audio_data.len() >= 2
                    && audio_data[0] == 0xFF
                    && (audio_data[1] & 0xE0) == 0xE0;

                assert!(
                    is_id3 || is_frame_sync || audio_data.len() > 100,
                    "Audio data doesn't look like valid MP3"
                );
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable - {}", e);
            }
            Err(e) => panic!("TTS test failed: {}", e),
        }
    }

    #[tokio::test]
    async fn should_use_voice_preset() {
        let service = EdgeTTSService::new();
        let params = EdgeTTSParams {
            text: "Testing voice preset.".to_string(),
            voice: Some("alloy".to_string()),
            ..Default::default()
        };

        match service.text_to_speech_with_params(&params).await {
            Ok(audio_data) => {
                assert!(!audio_data.is_empty(), "No audio data with preset voice");
                println!("SUCCESS: Preset voice generated {} bytes", audio_data.len());
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable - {}", e);
            }
            Err(e) => panic!("Voice preset test failed: {}", e),
        }
    }
}

mod different_voices {
    use super::*;

    #[tokio::test]
    async fn should_test_different_voices() {
        let voices = [
            ("en-US-MichelleNeural", "Michelle"),
            ("en-US-GuyNeural", "Guy"),
        ];

        let service = EdgeTTSService::new();

        for (voice_id, voice_name) in voices {
            let params = EdgeTTSParams {
                text: format!("Testing voice {}", voice_name),
                voice: Some(voice_id.to_string()),
                ..Default::default()
            };

            match service.text_to_speech_with_params(&params).await {
                Ok(audio_data) => {
                    assert!(
                        !audio_data.is_empty(),
                        "Voice {} returned empty data",
                        voice_name
                    );
                    println!("Voice {} working: {} bytes", voice_name, audio_data.len());
                }
                Err(ref e) if is_network_error(e) => {
                    eprintln!("Skipping: network unavailable for voice {}", voice_name);
                    break;
                }
                Err(e) => panic!("Voice {} failed: {}", voice_name, e),
            }
        }
    }
}

mod speed_and_rate {
    use super::*;

    #[tokio::test]
    async fn should_generate_with_speed() {
        let service = EdgeTTSService::new();
        let params = EdgeTTSParams {
            text: "Testing speed adjustment.".to_string(),
            speed: Some(1.5),
            ..Default::default()
        };

        match service.text_to_speech_with_params(&params).await {
            Ok(audio_data) => {
                assert!(!audio_data.is_empty(), "Speed adjustment returned empty data");
                println!(
                    "SUCCESS: Speed 1.5x generated {} bytes",
                    audio_data.len()
                );
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Speed test failed: {}", e),
        }
    }

    #[tokio::test]
    async fn should_generate_with_rate() {
        let service = EdgeTTSService::new();
        let params = EdgeTTSParams {
            text: "Testing rate adjustment.".to_string(),
            rate: Some("+20%".to_string()),
            ..Default::default()
        };

        match service.text_to_speech_with_params(&params).await {
            Ok(audio_data) => {
                assert!(!audio_data.is_empty(), "Rate adjustment returned empty data");
                println!("SUCCESS: Rate +20% generated {} bytes", audio_data.len());
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Rate test failed: {}", e),
        }
    }

    #[tokio::test]
    async fn should_generate_with_pitch() {
        let service = EdgeTTSService::new();
        let params = EdgeTTSParams {
            text: "Testing pitch adjustment.".to_string(),
            pitch: Some("+10Hz".to_string()),
            ..Default::default()
        };

        match service.text_to_speech_with_params(&params).await {
            Ok(audio_data) => {
                assert!(
                    !audio_data.is_empty(),
                    "Pitch adjustment returned empty data"
                );
                println!("SUCCESS: Pitch +10Hz generated {} bytes", audio_data.len());
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Pitch test failed: {}", e),
        }
    }

    #[tokio::test]
    async fn should_generate_with_volume() {
        let service = EdgeTTSService::new();
        let params = EdgeTTSParams {
            text: "Testing volume adjustment.".to_string(),
            volume: Some("+20%".to_string()),
            ..Default::default()
        };

        match service.text_to_speech_with_params(&params).await {
            Ok(audio_data) => {
                assert!(
                    !audio_data.is_empty(),
                    "Volume adjustment returned empty data"
                );
                println!(
                    "SUCCESS: Volume +20% generated {} bytes",
                    audio_data.len()
                );
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Volume test failed: {}", e),
        }
    }
}

mod long_text_input {
    use super::*;

    #[tokio::test]
    async fn should_handle_longer_text_input() {
        let long_text = "\
            This is a longer text to test the Edge TTS functionality. \
            We want to ensure that the service can handle sentences of reasonable length \
            and that the audio quality remains consistent throughout the entire speech. \
            This test verifies that longer inputs are processed correctly.";

        let service = EdgeTTSService::new();

        match service.text_to_speech(long_text).await {
            Ok(audio_data) => {
                assert!(
                    audio_data.len() > 1000,
                    "Long text produced too little audio: {} bytes",
                    audio_data.len()
                );
                println!(
                    "SUCCESS: Long text generated {} bytes of audio",
                    audio_data.len()
                );
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Long text test failed: {}", e),
        }
    }
}

mod plugin_integration {
    use super::*;

    #[tokio::test]
    async fn should_generate_through_plugin() {
        let mut plugin = EdgeTTSPlugin::new();

        match plugin.text_to_speech("Testing plugin integration.").await {
            Ok(audio_data) => {
                assert!(!audio_data.is_empty(), "Plugin returned empty audio");
                println!(
                    "SUCCESS: Plugin generated {} bytes of audio",
                    audio_data.len()
                );
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Plugin test failed: {}", e),
        }
    }

    #[tokio::test]
    async fn should_generate_with_custom_settings() {
        let settings = EdgeTTSSettings {
            voice: "en-US-GuyNeural".to_string(),
            rate: Some("+10%".to_string()),
            ..Default::default()
        };
        let mut plugin = EdgeTTSPlugin::with_settings(settings);

        match plugin.text_to_speech("Testing custom settings.").await {
            Ok(audio_data) => {
                assert!(!audio_data.is_empty(), "Custom settings returned empty audio");
                println!(
                    "SUCCESS: Custom settings generated {} bytes",
                    audio_data.len()
                );
            }
            Err(ref e) if is_network_error(e) => {
                eprintln!("Skipping: network unavailable");
            }
            Err(e) => panic!("Custom settings test failed: {}", e),
        }
    }
}
