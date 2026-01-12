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

wasm_bindgen_test_configure!(run_in_browser);

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


