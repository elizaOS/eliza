//! Integration tests for the ElevenLabs plugin.

use eliza_plugin_elevenlabs::{
    ElevenLabsPlugin, ElevenLabsSTTOptions, ElevenLabsTTSOptions, TranscriptionSettings,
    VoiceSettings, DEFAULT_STT_OPTIONS, DEFAULT_TTS_OPTIONS,
};

#[test]
fn test_voice_settings_default() {
    let settings = VoiceSettings::default();
    assert!((settings.stability - 0.5).abs() < f32::EPSILON);
    assert!((settings.similarity_boost - 0.75).abs() < f32::EPSILON);
    assert!((settings.style - 0.0).abs() < f32::EPSILON);
    assert!(settings.use_speaker_boost);
}

#[test]
fn test_voice_settings_custom() {
    let settings = VoiceSettings {
        stability: 0.8,
        similarity_boost: 0.9,
        style: 0.5,
        use_speaker_boost: false,
    };
    assert!((settings.stability - 0.8).abs() < f32::EPSILON);
    assert!((settings.similarity_boost - 0.9).abs() < f32::EPSILON);
    assert!((settings.style - 0.5).abs() < f32::EPSILON);
    assert!(!settings.use_speaker_boost);
}

#[test]
fn test_tts_options_default() {
    let options = ElevenLabsTTSOptions::default();
    assert!(options.api_key.is_empty());
    assert_eq!(options.voice_id, "EXAVITQu4vr4xnSDxMaL");
    assert_eq!(options.model_id, "eleven_monolingual_v1");
    assert_eq!(options.output_format, "mp3_44100_128");
    assert_eq!(options.optimize_streaming_latency, 0);
}

#[test]
fn test_tts_options_custom() {
    let options = ElevenLabsTTSOptions {
        api_key: "my-api-key".to_string(),
        voice_id: "custom-voice".to_string(),
        model_id: "eleven_multilingual_v2".to_string(),
        output_format: "pcm_16000".to_string(),
        optimize_streaming_latency: 2,
        voice_settings: VoiceSettings::default(),
    };
    assert_eq!(options.api_key, "my-api-key");
    assert_eq!(options.voice_id, "custom-voice");
    assert_eq!(options.model_id, "eleven_multilingual_v2");
}

#[test]
fn test_stt_options_default() {
    let options = ElevenLabsSTTOptions::default();
    assert!(options.api_key.is_empty());
    assert_eq!(options.model_id, "scribe_v1");
    assert!(options.language_code.is_none());
    assert_eq!(
        options.transcription_settings.timestamps_granularity,
        "word"
    );
    assert!(!options.transcription_settings.diarize);
}

#[test]
fn test_transcription_settings() {
    let settings = TranscriptionSettings {
        timestamps_granularity: "character".to_string(),
        diarize: true,
        num_speakers: Some(3),
        tag_audio_events: true,
    };
    assert_eq!(settings.timestamps_granularity, "character");
    assert!(settings.diarize);
    assert_eq!(settings.num_speakers, Some(3));
    assert!(settings.tag_audio_events);
}

#[test]
fn test_default_options_statics() {
    assert_eq!(DEFAULT_TTS_OPTIONS.voice_id, "EXAVITQu4vr4xnSDxMaL");
    assert_eq!(DEFAULT_STT_OPTIONS.model_id, "scribe_v1");
}

#[test]
fn test_plugin_default() {
    let plugin = ElevenLabsPlugin::new();
    assert_eq!(plugin.name, "elevenLabs");
    assert!(plugin.description.contains("text-to-speech"));
    assert!(plugin.description.contains("speech-to-text"));
}

#[test]
fn test_plugin_with_options() {
    let tts_options = ElevenLabsTTSOptions {
        api_key: "test-key".to_string(),
        voice_id: "test-voice".to_string(),
        ..Default::default()
    };
    let stt_options = ElevenLabsSTTOptions::default();

    let plugin = ElevenLabsPlugin::with_options(tts_options.clone(), stt_options);
    assert_eq!(plugin.tts_options.api_key, "test-key");
    assert_eq!(plugin.tts_options.voice_id, "test-voice");
}

#[test]
fn test_version() {
    assert!(!eliza_plugin_elevenlabs::VERSION.is_empty());
}
