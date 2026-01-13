//! WASM-specific tests for elizaOS Core
//!
//! These tests run in a browser environment using wasm-bindgen-test.
//!
//! To run these tests:
//! ```bash
//! wasm-pack test --headless --chrome --features wasm
//! ```

#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::*;

// Note: We don't set `run_in_browser` so tests can run in Node.js too
// For browser-only tests, add #[wasm_bindgen_test(run_in_browser)]

// ========================================
// WasmError Tests
// ========================================

mod error_tests {
    use super::*;
    use elizaos::wasm::error::WasmError;

    #[wasm_bindgen_test]
    fn test_wasm_error_creation() {
        let err = WasmError::parse_error("invalid json", Some("character".to_string()));
        assert_eq!(err.code(), "PARSE_ERROR");
        assert_eq!(err.message(), "invalid json");
        assert_eq!(err.source(), Some("character".to_string()));
    }

    #[wasm_bindgen_test]
    fn test_wasm_error_to_string() {
        let err = WasmError::parse_error("invalid json", Some("character".to_string()));
        assert_eq!(err.to_string_js(), "[PARSE_ERROR] character: invalid json");

        let err_no_source = WasmError::internal_error("something went wrong");
        assert_eq!(
            err_no_source.to_string_js(),
            "[INTERNAL_ERROR] something went wrong"
        );
    }

    #[wasm_bindgen_test]
    fn test_error_codes() {
        // Test various error constructors
        let parse = WasmError::parse_error("test", None);
        assert_eq!(parse.code(), "PARSE_ERROR");

        let validation = WasmError::validation_error("test", None);
        assert_eq!(validation.code(), "VALIDATION_ERROR");

        let not_found = WasmError::not_found("test", None);
        assert_eq!(not_found.code(), "NOT_FOUND");

        let not_init = WasmError::not_initialized("test");
        assert_eq!(not_init.code(), "NOT_INITIALIZED");

        let handler = WasmError::handler_error("test", None);
        assert_eq!(handler.code(), "HANDLER_ERROR");

        let internal = WasmError::internal_error("test");
        assert_eq!(internal.code(), "INTERNAL_ERROR");
    }
}

// ========================================
// JsModelHandler Tests
// ========================================

mod shim_tests {
    use super::*;
    use elizaos::wasm::shims::JsModelHandler;
    use js_sys::Object;
    use wasm_bindgen::JsCast;

    #[wasm_bindgen_test]
    fn test_js_model_handler_creation() {
        // Create a mock handler object
        let code = r#"
            ({
                calls: [],
                handle: async function(paramsJson) {
                    this.calls.push(paramsJson);
                    return JSON.stringify({ text: "response" });
                }
            })
        "#;

        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj.clone());
        assert!(handler.is_ok());
    }

    #[wasm_bindgen_test]
    fn test_js_model_handler_invalid_object() {
        // Object without handle function should fail
        let obj = Object::new();
        let result = JsModelHandler::new(obj);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_js_model_handler_handle_not_function() {
        // Object with handle that's not a function should fail
        let code = r#"({ handle: "not a function" })"#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let result = JsModelHandler::new(obj);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_create_mock_model_handler() {
        let handler = elizaos::wasm::shims::create_mock_model_handler();
        assert!(handler.is_ok());
    }
}

// ========================================
// Type Wrapper Tests
// ========================================

mod type_tests {
    use super::*;
    use elizaos::wasm::{
        WasmCharacter, WasmState, WasmUUID,
        generate_uuid, string_to_uuid, validate_uuid,
    };

    #[wasm_bindgen_test]
    fn test_wasm_uuid() {
        let uuid = WasmUUID::new();
        let uuid_str = uuid.to_string_js();
        assert!(validate_uuid(&uuid_str));
    }

    #[wasm_bindgen_test]
    fn test_uuid_from_string_valid() {
        let result = WasmUUID::from_string("550e8400-e29b-41d4-a716-446655440000");
        assert!(result.is_ok());
    }

    #[wasm_bindgen_test]
    fn test_uuid_from_string_invalid() {
        let result = WasmUUID::from_string("not-a-uuid");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_generate_uuid() {
        let uuid1 = generate_uuid();
        let uuid2 = generate_uuid();
        assert_ne!(uuid1, uuid2);
        assert!(validate_uuid(&uuid1));
        assert!(validate_uuid(&uuid2));
    }

    #[wasm_bindgen_test]
    fn test_string_to_uuid_deterministic() {
        let uuid1 = string_to_uuid("test");
        let uuid2 = string_to_uuid("test");
        assert_eq!(uuid1, uuid2);
        
        let uuid3 = string_to_uuid("different");
        assert_ne!(uuid1, uuid3);
    }

    #[wasm_bindgen_test]
    fn test_wasm_character_from_json() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let result = WasmCharacter::from_json(json);
        assert!(result.is_ok());
        
        let character = result.unwrap();
        assert_eq!(character.name(), "TestAgent");
    }

    #[wasm_bindgen_test]
    fn test_wasm_character_invalid_json() {
        let result = WasmCharacter::from_json("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_state_default() {
        let state = WasmState::new();
        let json = state.to_json();
        assert!(json.is_ok());
    }
}

// ========================================
// Runtime Tests
// ========================================

mod runtime_tests {
    use super::*;
    use elizaos::wasm::WasmAgentRuntime;

    #[wasm_bindgen_test]
    fn test_create_runtime() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let result = WasmAgentRuntime::create(json);
        assert!(result.is_ok());
        
        let runtime = result.unwrap();
        assert_eq!(runtime.character_name(), "TestAgent");
    }

    #[wasm_bindgen_test]
    fn test_create_runtime_invalid_json() {
        let result = WasmAgentRuntime::create("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_runtime_initialize() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        
        let init_result = runtime.initialize();
        assert!(init_result.is_ok());
    }

    #[wasm_bindgen_test]
    fn test_runtime_agent_id() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        
        let agent_id = runtime.agent_id();
        assert!(!agent_id.is_empty());
    }

    #[wasm_bindgen_test]
    fn test_runtime_character() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent", "system": "You are helpful"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        
        let character_json = runtime.character();
        assert!(character_json.is_ok());
        
        let char_str = character_json.unwrap();
        assert!(char_str.contains("TestAgent"));
    }

    #[wasm_bindgen_test]
    fn test_runtime_stop() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        runtime.initialize().unwrap();
        
        // Should not panic
        runtime.stop();
    }
}

// ========================================
// Interop Round-Trip Tests
// ========================================

mod interop_tests {
    use super::*;
    use elizaos::wasm::{test_character_round_trip, test_memory_round_trip};

    #[wasm_bindgen_test]
    fn test_character_serialization_round_trip() {
        let json = r#"{
            "name": "TestAgent",
            "bio": "A test agent",
            "system": "You are a helpful assistant",
            "topics": ["testing", "rust"]
        }"#;
        
        let result = test_character_round_trip(json);
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[wasm_bindgen_test]
    fn test_memory_serialization_round_trip() {
        let json = r#"{
            "entityId": "550e8400-e29b-41d4-a716-446655440000",
            "roomId": "550e8400-e29b-41d4-a716-446655440001",
            "content": {"text": "Hello world"},
            "unique": true
        }"#;
        
        let result = test_memory_round_trip(json);
        assert!(result.is_ok());
        assert!(result.unwrap());
    }
}

// ========================================
// Additional Type Wrapper Tests
// ========================================

mod additional_type_tests {
    use super::*;
    use elizaos::wasm::{
        WasmMemory, WasmAgent, WasmPlugin, WasmRoom, WasmEntity,
        parse_character, parse_memory, get_version,
    };

    #[wasm_bindgen_test]
    fn test_wasm_memory_from_json() {
        let json = r#"{
            "entityId": "550e8400-e29b-41d4-a716-446655440000",
            "roomId": "550e8400-e29b-41d4-a716-446655440001",
            "content": {"text": "Hello world"},
            "unique": true
        }"#;
        
        let memory = WasmMemory::from_json(json).unwrap();
        assert_eq!(memory.entity_id(), "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(memory.room_id(), "550e8400-e29b-41d4-a716-446655440001");
        assert!(memory.unique());
    }

    #[wasm_bindgen_test]
    fn test_wasm_memory_invalid_json() {
        let result = WasmMemory::from_json("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_memory_missing_required_field() {
        // Missing roomId
        let json = r#"{
            "entityId": "550e8400-e29b-41d4-a716-446655440000",
            "content": {"text": "Hello"}
        }"#;
        let result = WasmMemory::from_json(json);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_memory_content_getter() {
        let json = r#"{
            "entityId": "550e8400-e29b-41d4-a716-446655440000",
            "roomId": "550e8400-e29b-41d4-a716-446655440001",
            "content": {"text": "Test message", "action": "REPLY"}
        }"#;
        
        let memory = WasmMemory::from_json(json).unwrap();
        let content = memory.content().unwrap();
        assert!(content.contains("Test message"));
    }

    #[wasm_bindgen_test]
    fn test_wasm_agent_from_json() {
        // Agent uses #[serde(flatten)] for character, plus createdAt/updatedAt
        let json = r#"{
            "name": "TestAgent",
            "bio": "A test agent",
            "createdAt": 1234567890,
            "updatedAt": 1234567890
        }"#;
        
        let agent = WasmAgent::from_json(json).unwrap();
        assert_eq!(agent.name(), "TestAgent");
    }

    #[wasm_bindgen_test]
    fn test_wasm_agent_invalid_json() {
        let result = WasmAgent::from_json("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_agent_missing_required_fields() {
        // Missing createdAt/updatedAt
        let json = r#"{ "name": "TestAgent", "bio": "Test" }"#;
        let result = WasmAgent::from_json(json);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_plugin_from_json() {
        let json = r#"{
            "name": "test-plugin",
            "description": "A test plugin"
        }"#;
        
        let plugin = WasmPlugin::from_json(json).unwrap();
        assert_eq!(plugin.name(), "test-plugin");
        assert_eq!(plugin.description(), Some("A test plugin".to_string()));
    }

    #[wasm_bindgen_test]
    fn test_wasm_plugin_invalid_json() {
        let result = WasmPlugin::from_json("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_room_from_json() {
        // Room requires: id, source, type (as room_type)
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "source": "discord",
            "type": "DM"
        }"#;
        
        let room = WasmRoom::from_json(json).unwrap();
        assert_eq!(room.id(), "550e8400-e29b-41d4-a716-446655440000");
    }

    #[wasm_bindgen_test]
    fn test_wasm_room_invalid_json() {
        let result = WasmRoom::from_json("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_room_missing_required_fields() {
        // Missing source and type
        let json = r#"{ "id": "550e8400-e29b-41d4-a716-446655440000" }"#;
        let result = WasmRoom::from_json(json);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_entity_from_json() {
        // Entity requires: names, metadata, agentId
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "names": ["TestEntity"],
            "metadata": {},
            "agentId": "550e8400-e29b-41d4-a716-446655440001"
        }"#;
        
        let entity = WasmEntity::from_json(json).unwrap();
        assert_eq!(entity.id(), Some("550e8400-e29b-41d4-a716-446655440000".to_string()));
    }

    #[wasm_bindgen_test]
    fn test_wasm_entity_invalid_json() {
        let result = WasmEntity::from_json("not json");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_wasm_entity_missing_required_fields() {
        // Missing names, metadata, agentId
        let json = r#"{ "id": "550e8400-e29b-41d4-a716-446655440000" }"#;
        let result = WasmEntity::from_json(json);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_parse_character_helper() {
        let json = r#"{"name": "TestAgent", "bio": "Test"}"#;
        let character = parse_character(json).unwrap();
        assert_eq!(character.name(), "TestAgent");
    }

    #[wasm_bindgen_test]
    fn test_parse_memory_helper() {
        let json = r#"{
            "entityId": "550e8400-e29b-41d4-a716-446655440000",
            "roomId": "550e8400-e29b-41d4-a716-446655440001",
            "content": {"text": "Hello"}
        }"#;
        let memory = parse_memory(json).unwrap();
        assert_eq!(memory.entity_id(), "550e8400-e29b-41d4-a716-446655440000");
    }

    #[wasm_bindgen_test]
    fn test_get_version() {
        let version = get_version();
        assert!(!version.is_empty());
        // Should be semver format
        assert!(version.contains('.'));
    }
}

// ========================================
// Edge Cases for string_to_uuid
// ========================================

mod uuid_edge_cases {
    use super::*;
    use elizaos::wasm::{string_to_uuid, validate_uuid};

    #[wasm_bindgen_test]
    fn test_string_to_uuid_empty_string() {
        let uuid = string_to_uuid("");
        assert!(validate_uuid(&uuid));
    }

    #[wasm_bindgen_test]
    fn test_string_to_uuid_special_chars() {
        let uuid = string_to_uuid("hello!@#$%^&*()_+-=[]{}|;':\",./<>?");
        assert!(validate_uuid(&uuid));
    }

    #[wasm_bindgen_test]
    fn test_string_to_uuid_unicode() {
        let uuid = string_to_uuid("こんにちは世界🌍");
        assert!(validate_uuid(&uuid));
    }

    #[wasm_bindgen_test]
    fn test_string_to_uuid_very_long_string() {
        let long_string = "a".repeat(10000);
        let uuid = string_to_uuid(&long_string);
        assert!(validate_uuid(&uuid));
    }

    #[wasm_bindgen_test]
    fn test_string_to_uuid_whitespace() {
        let uuid1 = string_to_uuid("  test  ");
        let uuid2 = string_to_uuid("test");
        // Should be different (whitespace matters)
        assert_ne!(uuid1, uuid2);
    }
}

// ========================================
// Error Extension Trait Tests
// ========================================

mod error_extension_tests {
    use super::*;
    use elizaos::wasm::error::WasmError;

    #[wasm_bindgen_test]
    fn test_from_json_error() {
        let bad_json = "{ not valid json }";
        let err: Result<serde_json::Value, _> = serde_json::from_str(bad_json);
        let json_err = err.unwrap_err();
        
        let wasm_err = WasmError::from_json_error(&json_err, Some("test_field".to_string()));
        assert_eq!(wasm_err.code(), "PARSE_ERROR");
        assert!(wasm_err.message().contains("JSON parse error"));
        assert_eq!(wasm_err.source(), Some("test_field".to_string()));
    }

    #[wasm_bindgen_test]
    fn test_wasm_error_display() {
        let err = WasmError::validation_error("invalid value", Some("field".to_string()));
        let display = format!("{}", err);
        assert_eq!(display, "[VALIDATION_ERROR] field: invalid value");
    }

    #[wasm_bindgen_test]
    fn test_wasm_error_new_custom_code() {
        let err = WasmError::new("CUSTOM_CODE", "custom message", Some("source".to_string()));
        assert_eq!(err.code(), "CUSTOM_CODE");
        assert_eq!(err.message(), "custom message");
        assert_eq!(err.source(), Some("source".to_string()));
    }
}

// ========================================
// Advanced JsModelHandler Tests
// ========================================

mod advanced_shim_tests {
    use super::*;
    use elizaos::wasm::shims::JsModelHandler;
    use js_sys::Object;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;

    #[wasm_bindgen_test]
    async fn test_js_model_handler_call_sync() {
        // Create a sync handler (returns string directly)
        let code = r#"
            ({
                handle: function(paramsJson) {
                    return JSON.stringify({ result: "sync_response" });
                }
            })
        "#;

        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj).unwrap();
        
        let promise = handler.handle_js("{}").unwrap();
        let result = JsFuture::from(promise).await.unwrap();
        let response = result.as_string().unwrap();
        assert!(response.contains("sync_response"));
    }

    #[wasm_bindgen_test]
    async fn test_js_model_handler_call_async() {
        // Create an async handler
        let code = r#"
            ({
                handle: async function(paramsJson) {
                    const params = JSON.parse(paramsJson);
                    return JSON.stringify({ 
                        echo: params.prompt,
                        processed: true 
                    });
                }
            })
        "#;

        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj).unwrap();
        
        let params = r#"{"prompt": "hello"}"#;
        let promise = handler.handle_js(params).unwrap();
        let result = JsFuture::from(promise).await.unwrap();
        let response = result.as_string().unwrap();
        assert!(response.contains("hello"));
        assert!(response.contains("processed"));
    }

    #[wasm_bindgen_test]
    fn test_js_model_handler_js_object_getter() {
        let code = r#"({ handle: function() { return "test"; }, customProp: 42 })"#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj.clone()).unwrap();
        
        // Should return the same object
        let returned_obj = handler.js_object();
        let custom_prop = js_sys::Reflect::get(&returned_obj, &"customProp".into()).unwrap();
        assert_eq!(custom_prop.as_f64().unwrap(), 42.0);
    }

    #[wasm_bindgen_test]
    fn test_js_model_handler_null_handle() {
        let code = r#"({ handle: null })"#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let result = JsModelHandler::new(obj);
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_js_model_handler_undefined_handle() {
        let code = r#"({ handle: undefined })"#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let result = JsModelHandler::new(obj);
        assert!(result.is_err());
    }
}

// ========================================
// Advanced Runtime Tests  
// ========================================

mod advanced_runtime_tests {
    use super::*;
    use elizaos::wasm::{WasmAgentRuntime, WasmCharacter};
    use elizaos::wasm::shims::JsModelHandler;
    use js_sys::Object;
    use wasm_bindgen::JsCast;

    #[wasm_bindgen_test]
    fn test_runtime_register_model_handler() {
        let json = r#"{"name": "TestAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        
        let code = r#"({ handle: async function(p) { return "{}"; } })"#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj).unwrap();
        
        // Should not panic
        runtime.register_model_handler("TEXT_LARGE", handler);
    }

    #[wasm_bindgen_test]
    fn test_runtime_register_model_handler_fn() {
        let json = r#"{"name": "TestAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        
        let code = r#"(async function(p) { return "{}"; })"#;
        let func: js_sys::Function = js_sys::eval(code).unwrap().dyn_into().unwrap();
        
        // Should succeed
        let result = runtime.register_model_handler_fn("TEXT_LARGE", func);
        assert!(result.is_ok());
    }

    #[wasm_bindgen_test]
    fn test_runtime_agent_id_deterministic() {
        // Same character name should produce same agent ID
        let json = r#"{"name": "DeterministicAgent", "bio": "Test"}"#;
        let runtime1 = WasmAgentRuntime::create(json).unwrap();
        let runtime2 = WasmAgentRuntime::create(json).unwrap();
        
        assert_eq!(runtime1.agent_id(), runtime2.agent_id());
    }

    #[wasm_bindgen_test]
    fn test_runtime_with_explicit_id() {
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "TestAgent",
            "bio": "Test"
        }"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        
        assert_eq!(runtime.agent_id(), "550e8400-e29b-41d4-a716-446655440000");
    }

    #[wasm_bindgen_test]
    fn test_runtime_multiple_stop_calls() {
        let json = r#"{"name": "TestAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        runtime.initialize().unwrap();
        
        // Multiple stops should be safe
        runtime.stop();
        runtime.stop();
        runtime.stop();
    }

    #[wasm_bindgen_test]
    fn test_character_system_prompt() {
        let json = r#"{
            "name": "SystemAgent",
            "bio": "Test",
            "system": "You are a helpful assistant"
        }"#;
        let character = WasmCharacter::from_json(json).unwrap();
        
        assert_eq!(character.system(), Some("You are a helpful assistant".to_string()));
    }

    #[wasm_bindgen_test]
    fn test_character_topics() {
        let json = r#"{
            "name": "TopicAgent",
            "bio": "Test",
            "topics": ["ai", "rust", "wasm"]
        }"#;
        let character = WasmCharacter::from_json(json).unwrap();
        
        let topics = character.topics().unwrap();
        assert!(topics.contains("ai"));
        assert!(topics.contains("rust"));
        assert!(topics.contains("wasm"));
    }

    #[wasm_bindgen_test]
    fn test_character_bio_array() {
        let json = r#"{
            "name": "BioAgent",
            "bio": ["Line 1", "Line 2", "Line 3"]
        }"#;
        let character = WasmCharacter::from_json(json).unwrap();
        
        let bio = character.bio().unwrap();
        assert!(bio.contains("Line 1"));
    }
}


