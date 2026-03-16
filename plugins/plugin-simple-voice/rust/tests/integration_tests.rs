use eliza_plugin_simple_voice::types::{CallbackResult, Memory, MemoryContent, SAM_SERVICE_TYPE};
use eliza_plugin_simple_voice::{
    extract_text_to_speak, extract_voice_options, SamEngine, SamTTSOptions, SamTTSService,
    SayAloudAction, SimpleVoicePlugin, DEFAULT_SAM_OPTIONS, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS,
};
use std::collections::HashMap;

// =============================================================================
// SamTTSOptions Tests
// =============================================================================

#[test]
fn test_sam_tts_options_default() {
    let options = SamTTSOptions::default();
    assert_eq!(options.speed, 72);
    assert_eq!(options.pitch, 64);
    assert_eq!(options.throat, 128);
    assert_eq!(options.mouth, 128);
}

#[test]
fn test_sam_tts_options_custom() {
    let options = SamTTSOptions {
        speed: 100,
        pitch: 80,
        throat: 150,
        mouth: 160,
    };
    assert_eq!(options.speed, 100);
    assert_eq!(options.pitch, 80);
    assert_eq!(options.throat, 150);
    assert_eq!(options.mouth, 160);
}

#[test]
fn test_default_sam_options_constant() {
    assert_eq!(DEFAULT_SAM_OPTIONS.speed, 72);
    assert_eq!(DEFAULT_SAM_OPTIONS.pitch, 64);
    assert_eq!(DEFAULT_SAM_OPTIONS.throat, 128);
    assert_eq!(DEFAULT_SAM_OPTIONS.mouth, 128);
}

#[test]
fn test_sam_service_type_constant() {
    assert_eq!(SAM_SERVICE_TYPE, "SAM_TTS");
}

// =============================================================================
// Speech Triggers Tests
// =============================================================================

#[test]
fn test_speech_triggers_not_empty() {
    assert!(!SPEECH_TRIGGERS.is_empty());
}

#[test]
fn test_speech_triggers_contains_common() {
    assert!(SPEECH_TRIGGERS.contains(&"speak"));
    assert!(SPEECH_TRIGGERS.contains(&"say aloud"));
    assert!(SPEECH_TRIGGERS.contains(&"read aloud"));
    assert!(SPEECH_TRIGGERS.contains(&"voice"));
}

#[test]
fn test_speech_triggers_contains_voice_modifiers() {
    assert!(SPEECH_TRIGGERS.contains(&"higher voice"));
    assert!(SPEECH_TRIGGERS.contains(&"lower voice"));
    assert!(SPEECH_TRIGGERS.contains(&"robotic voice"));
    assert!(SPEECH_TRIGGERS.contains(&"retro voice"));
}

#[test]
fn test_speech_triggers_all_lowercase() {
    for trigger in SPEECH_TRIGGERS {
        assert_eq!(*trigger, trigger.to_lowercase());
    }
}

// =============================================================================
// Vocalization Patterns Tests
// =============================================================================

#[test]
fn test_vocalization_patterns_not_empty() {
    assert!(!VOCALIZATION_PATTERNS.is_empty());
}

#[test]
fn test_vocalization_patterns_contains_common() {
    assert!(VOCALIZATION_PATTERNS.contains(&"can you say"));
    assert!(VOCALIZATION_PATTERNS.contains(&"please say"));
    assert!(VOCALIZATION_PATTERNS.contains(&"i want to hear"));
    assert!(VOCALIZATION_PATTERNS.contains(&"let me hear"));
}

#[test]
fn test_vocalization_patterns_all_lowercase() {
    for pattern in VOCALIZATION_PATTERNS {
        assert_eq!(*pattern, pattern.to_lowercase());
    }
}

// =============================================================================
// Serialization Tests
// =============================================================================

#[test]
fn test_sam_tts_options_serialization() {
    let options = SamTTSOptions {
        speed: 100,
        pitch: 80,
        throat: 150,
        mouth: 160,
    };

    let json = serde_json::to_string(&options).unwrap();
    assert!(json.contains("100"));
    assert!(json.contains("80"));

    let parsed: SamTTSOptions = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.speed, 100);
    assert_eq!(parsed.pitch, 80);
}

#[test]
fn test_memory_content_serialization() {
    let mut extra = HashMap::new();
    extra.insert("key".to_string(), serde_json::json!("value"));

    let content = MemoryContent {
        text: "Hello world".to_string(),
        extra,
    };

    let json = serde_json::to_string(&content).unwrap();
    assert!(json.contains("Hello world"));
    assert!(json.contains("key"));
}

#[test]
fn test_memory_serialization() {
    let memory = Memory {
        id: "mem-1".to_string(),
        entity_id: "entity-1".to_string(),
        agent_id: "agent-1".to_string(),
        room_id: "room-1".to_string(),
        content: MemoryContent {
            text: "Test memory".to_string(),
            extra: HashMap::new(),
        },
        created_at: 1234567890,
    };

    let json = serde_json::to_string(&memory).unwrap();
    assert!(json.contains("mem-1"));
    assert!(json.contains("agent-1"));
    assert!(json.contains("Test memory"));
}

#[test]
fn test_callback_result_serialization() {
    let result = CallbackResult {
        text: "Action completed".to_string(),
        action: "speak".to_string(),
        audio_data: Some(vec![0, 1, 2, 3]),
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("Action completed"));
    assert!(json.contains("speak"));
}

#[test]
fn test_callback_result_without_audio() {
    let result = CallbackResult {
        text: "Action completed".to_string(),
        action: "speak".to_string(),
        audio_data: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("Action completed"));
    assert!(!json.contains("audio_data"));
}

// =============================================================================
// SamEngine Tests
// =============================================================================

#[test]
fn test_sam_engine_default() {
    let engine = SamEngine::default();
    let audio = engine.synthesize("Test");
    assert!(!audio.is_empty());
}

#[test]
fn test_sam_engine_custom_options() {
    let options = SamTTSOptions {
        speed: 100,
        pitch: 80,
        throat: 128,
        mouth: 128,
    };
    let engine = SamEngine::new(options);
    let audio = engine.synthesize("Test");
    assert!(!audio.is_empty());
}

#[test]
fn test_sam_engine_speed_affects_length() {
    let slow = SamEngine::new(SamTTSOptions {
        speed: 40,
        ..Default::default()
    });
    let fast = SamEngine::new(SamTTSOptions {
        speed: 120,
        ..Default::default()
    });

    let slow_audio = slow.synthesize("Test");
    let fast_audio = fast.synthesize("Test");

    assert_ne!(slow_audio.len(), fast_audio.len());
}

#[test]
fn test_sam_engine_buf8_same_as_synthesize() {
    let engine = SamEngine::default();
    let synth = engine.synthesize("Hello");
    let buf8 = engine.buf8("Hello");
    assert_eq!(synth, buf8);
}

// =============================================================================
// SamTTSService Tests
// =============================================================================

#[test]
fn test_sam_tts_service_type() {
    assert_eq!(SamTTSService::SERVICE_TYPE, "SAM_TTS");
}

#[test]
fn test_sam_tts_service_default() {
    let service = SamTTSService::default();
    let audio = service.generate_audio("Hello", None);
    assert!(!audio.is_empty());
}

#[test]
fn test_sam_tts_service_with_options() {
    let service = SamTTSService::default();
    let options = SamTTSOptions {
        speed: 100,
        pitch: 80,
        throat: 128,
        mouth: 128,
    };
    let audio = service.generate_audio("Hello", Some(options));
    assert!(!audio.is_empty());
}

#[test]
fn test_sam_tts_service_create_wav_buffer() {
    let service = SamTTSService::default();
    let audio = service.generate_audio("Test", None);
    let wav = service.create_wav_buffer(&audio, 22050);

    // Check header size
    assert_eq!(wav.len(), audio.len() + 44);

    // Check RIFF header
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(&wav[12..16], b"fmt ");
    assert_eq!(&wav[36..40], b"data");
}

#[test]
fn test_sam_tts_service_create_wav_empty_audio() {
    let service = SamTTSService::default();
    let wav = service.create_wav_buffer(&[], 22050);
    assert_eq!(wav.len(), 44);
    assert_eq!(&wav[0..4], b"RIFF");
}

#[test]
fn test_sam_tts_service_capability_description() {
    let service = SamTTSService::default();
    let desc = service.capability_description();
    assert!(desc.contains("SAM"));
    assert!(desc.contains("TTS"));
}

// =============================================================================
// Extract Text To Speak Tests
// =============================================================================

#[test]
fn test_extract_text_quoted_single() {
    assert_eq!(extract_text_to_speak("say 'hello world'"), "hello world");
}

#[test]
fn test_extract_text_quoted_double() {
    assert_eq!(extract_text_to_speak("say \"hello world\""), "hello world");
}

#[test]
fn test_extract_text_speak_quoted() {
    assert_eq!(
        extract_text_to_speak("speak 'test message'"),
        "test message"
    );
}

#[test]
fn test_extract_text_read_quoted() {
    assert_eq!(extract_text_to_speak("read \"the text\""), "the text");
}

#[test]
fn test_extract_text_say_aloud() {
    let result = extract_text_to_speak("say aloud hello there");
    assert!(result.contains("hello"));
}

#[test]
fn test_extract_text_can_you_say() {
    let result = extract_text_to_speak("can you say hello");
    assert!(result.contains("hello"));
}

#[test]
fn test_extract_text_please_say() {
    let result = extract_text_to_speak("please say goodbye");
    assert!(result.contains("goodbye"));
}

#[test]
fn test_extract_text_no_pattern() {
    assert_eq!(extract_text_to_speak("hello world"), "hello world");
}

// =============================================================================
// Extract Voice Options Tests
// =============================================================================

#[test]
fn test_extract_voice_default() {
    let options = extract_voice_options("say hello");
    assert_eq!(options.speed, 72);
    assert_eq!(options.pitch, 64);
}

#[test]
fn test_extract_voice_higher() {
    let options = extract_voice_options("speak in a higher voice");
    assert_eq!(options.pitch, 100);
}

#[test]
fn test_extract_voice_lower() {
    let options = extract_voice_options("speak in a lower voice");
    assert_eq!(options.pitch, 30);
}

#[test]
fn test_extract_voice_faster() {
    let options = extract_voice_options("say it faster");
    assert_eq!(options.speed, 120);
}

#[test]
fn test_extract_voice_slower() {
    let options = extract_voice_options("say it slower");
    assert_eq!(options.speed, 40);
}

#[test]
fn test_extract_voice_robotic() {
    let options = extract_voice_options("use a robotic voice");
    assert_eq!(options.throat, 200);
    assert_eq!(options.mouth, 50);
}

#[test]
fn test_extract_voice_smooth() {
    let options = extract_voice_options("speak in a smooth voice");
    assert_eq!(options.throat, 100);
    assert_eq!(options.mouth, 150);
}

// =============================================================================
// SayAloudAction Tests
// =============================================================================

#[test]
fn test_say_aloud_action_name() {
    let action = SayAloudAction::new();
    assert_eq!(action.name, "SAY_ALOUD");
}

#[test]
fn test_say_aloud_action_description() {
    let action = SayAloudAction::new();
    assert!(action.description.contains("SAM"));
}

#[test]
fn test_say_aloud_action_validate_say_aloud() {
    let action = SayAloudAction::new();
    let memory = Memory {
        id: "1".into(),
        entity_id: "1".into(),
        agent_id: "1".into(),
        room_id: "1".into(),
        content: MemoryContent {
            text: "say aloud hello".into(),
            extra: HashMap::new(),
        },
        created_at: 0,
    };
    assert!(action.validate(&memory));
}

#[test]
fn test_say_aloud_action_validate_speak() {
    let action = SayAloudAction::new();
    let memory = Memory {
        id: "1".into(),
        entity_id: "1".into(),
        agent_id: "1".into(),
        room_id: "1".into(),
        content: MemoryContent {
            text: "speak this text".into(),
            extra: HashMap::new(),
        },
        created_at: 0,
    };
    assert!(action.validate(&memory));
}

#[test]
fn test_say_aloud_action_validate_can_you_say() {
    let action = SayAloudAction::new();
    let memory = Memory {
        id: "1".into(),
        entity_id: "1".into(),
        agent_id: "1".into(),
        room_id: "1".into(),
        content: MemoryContent {
            text: "can you say hello".into(),
            extra: HashMap::new(),
        },
        created_at: 0,
    };
    assert!(action.validate(&memory));
}

#[test]
fn test_say_aloud_action_validate_quoted() {
    let action = SayAloudAction::new();
    let memory = Memory {
        id: "1".into(),
        entity_id: "1".into(),
        agent_id: "1".into(),
        room_id: "1".into(),
        content: MemoryContent {
            text: "say 'hello world'".into(),
            extra: HashMap::new(),
        },
        created_at: 0,
    };
    assert!(action.validate(&memory));
}

#[test]
fn test_say_aloud_action_rejects_normal_text() {
    let action = SayAloudAction::new();
    let memory = Memory {
        id: "1".into(),
        entity_id: "1".into(),
        agent_id: "1".into(),
        room_id: "1".into(),
        content: MemoryContent {
            text: "hello world".into(),
            extra: HashMap::new(),
        },
        created_at: 0,
    };
    assert!(!action.validate(&memory));
}

#[test]
fn test_say_aloud_action_rejects_question() {
    let action = SayAloudAction::new();
    let memory = Memory {
        id: "1".into(),
        entity_id: "1".into(),
        agent_id: "1".into(),
        room_id: "1".into(),
        content: MemoryContent {
            text: "what is the weather".into(),
            extra: HashMap::new(),
        },
        created_at: 0,
    };
    assert!(!action.validate(&memory));
}

// =============================================================================
// SimpleVoicePlugin Tests
// =============================================================================

#[test]
fn test_plugin_name() {
    let plugin = SimpleVoicePlugin::new();
    assert_eq!(plugin.name, "@elizaos/plugin-simple-voice");
}

#[test]
fn test_plugin_description() {
    let plugin = SimpleVoicePlugin::new();
    assert!(plugin.description.contains("SAM"));
}
