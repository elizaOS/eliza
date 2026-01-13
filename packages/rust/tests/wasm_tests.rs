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
        generate_uuid, string_to_uuid, validate_uuid, WasmCharacter, WasmState, WasmUUID,
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
    async fn test_runtime_initialize() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();

        // initialize() now returns a Promise
        assert!(!runtime.is_initialized());
        let promise = runtime.initialize();
        wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();
        assert!(runtime.is_initialized());
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
    async fn test_runtime_stop() {
        let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();

        // Should not panic
        runtime.stop();
        assert!(!runtime.is_initialized());
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
        get_version, parse_character, parse_memory, WasmAgent, WasmEntity, WasmMemory, WasmPlugin,
        WasmRoom,
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
        assert_eq!(
            entity.id(),
            Some("550e8400-e29b-41d4-a716-446655440000".to_string())
        );
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

// ========================================
// Core Trait Tests (WASM) - Tests for PR #3
// ========================================

mod core_trait_tests {
    use super::*;
    use elizaos::types::components::{
        ActionDefinition, ActionHandler, ActionResult, EvaluatorDefinition, EvaluatorHandler,
        HandlerOptions, ProviderDefinition, ProviderHandler, ProviderResult,
    };
    use elizaos::types::memory::Memory;
    use elizaos::types::primitives::UUID;
    use elizaos::types::state::State;
    use std::cell::RefCell;
    use std::rc::Rc;

    // Helper to create a test memory
    fn create_test_memory() -> Memory {
        Memory {
            id: None,
            entity_id: UUID::new_v4(),
            agent_id: None,
            room_id: UUID::new_v4(),
            content: Default::default(),
            created_at: None,
            embedding: None,
            world_id: None,
            unique: None,
            similarity: None,
            metadata: None,
        }
    }

    // Test ActionHandler with non-Send types (only works in WASM)
    struct WasmActionHandler {
        // Non-Send type - would fail on native with Send + Sync bounds
        call_count: Rc<RefCell<u32>>,
    }

    #[async_trait::async_trait(?Send)]
    impl ActionHandler for WasmActionHandler {
        fn definition(&self) -> ActionDefinition {
            ActionDefinition {
                name: "wasm_action".to_string(),
                description: "A WASM-only action".to_string(),
                similes: None,
                examples: None,
                priority: None,
                tags: None,
                parameters: None,
            }
        }

        async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
            true
        }

        async fn handle(
            &self,
            _message: &Memory,
            _state: Option<&State>,
            _options: Option<&HandlerOptions>,
        ) -> Result<Option<ActionResult>, anyhow::Error> {
            *self.call_count.borrow_mut() += 1;
            Ok(Some(ActionResult::success_with_text("handled")))
        }
    }

    #[wasm_bindgen_test]
    async fn test_wasm_action_handler_with_non_send() {
        let call_count = Rc::new(RefCell::new(0u32));
        let handler = WasmActionHandler {
            call_count: call_count.clone(),
        };

        // Verify definition
        let def = handler.definition();
        assert_eq!(def.name, "wasm_action");

        let memory = create_test_memory();

        // Validate should return true
        assert!(handler.validate(&memory, None).await);

        // Handle should increment call count
        let result = handler.handle(&memory, None, None).await.unwrap();
        assert!(result.is_some());
        assert!(result.unwrap().success);
        assert_eq!(*call_count.borrow(), 1);

        // Call again
        let _ = handler.handle(&memory, None, None).await;
        assert_eq!(*call_count.borrow(), 2);
    }

    // Test ProviderHandler with non-Send types
    struct WasmProviderHandler {
        data: Rc<RefCell<String>>,
    }

    #[async_trait::async_trait(?Send)]
    impl ProviderHandler for WasmProviderHandler {
        fn definition(&self) -> ProviderDefinition {
            ProviderDefinition {
                name: "wasm_provider".to_string(),
                description: Some("A WASM-only provider".to_string()),
                dynamic: None,
                position: None,
                private: None,
            }
        }

        async fn get(
            &self,
            _message: &Memory,
            _state: &State,
        ) -> Result<ProviderResult, anyhow::Error> {
            let data = self.data.borrow().clone();
            Ok(ProviderResult {
                text: Some(format!("Provider data: {}", data)),
                values: None,
                data: None,
            })
        }
    }

    #[wasm_bindgen_test]
    async fn test_wasm_provider_handler_with_non_send() {
        let data = Rc::new(RefCell::new("test_data".to_string()));
        let handler = WasmProviderHandler { data: data.clone() };

        let def = handler.definition();
        assert_eq!(def.name, "wasm_provider");

        let memory = create_test_memory();
        let state = State::default();

        let result = handler.get(&memory, &state).await.unwrap();
        assert!(result.text.unwrap().contains("test_data"));

        // Modify data and verify provider sees change
        *data.borrow_mut() = "modified".to_string();
        let result2 = handler.get(&memory, &state).await.unwrap();
        assert!(result2.text.unwrap().contains("modified"));
    }

    // Test EvaluatorHandler with non-Send types
    struct WasmEvaluatorHandler {
        threshold: Rc<RefCell<f64>>,
    }

    #[async_trait::async_trait(?Send)]
    impl EvaluatorHandler for WasmEvaluatorHandler {
        fn definition(&self) -> EvaluatorDefinition {
            EvaluatorDefinition {
                name: "wasm_evaluator".to_string(),
                description: "A WASM-only evaluator".to_string(),
                always_run: None,
                similes: None,
                examples: vec![],
            }
        }

        async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
            *self.threshold.borrow() > 0.5
        }

        async fn handle(
            &self,
            _message: &Memory,
            _state: Option<&State>,
        ) -> Result<Option<ActionResult>, anyhow::Error> {
            let score = *self.threshold.borrow();
            Ok(Some(ActionResult::success_with_text(&format!(
                "Score: {}",
                score
            ))))
        }
    }

    #[wasm_bindgen_test]
    async fn test_wasm_evaluator_handler_with_non_send() {
        let threshold = Rc::new(RefCell::new(0.75));
        let handler = WasmEvaluatorHandler {
            threshold: threshold.clone(),
        };

        let def = handler.definition();
        assert_eq!(def.name, "wasm_evaluator");

        let memory = create_test_memory();

        // Should validate with threshold > 0.5
        assert!(handler.validate(&memory, None).await);

        // Lower threshold
        *threshold.borrow_mut() = 0.3;
        assert!(!handler.validate(&memory, None).await);

        // Handle still works regardless
        let result = handler.handle(&memory, None).await.unwrap();
        assert!(result.unwrap().text.unwrap().contains("0.3"));
    }

    // Test multiple handlers in a Vec (trait object collection)
    #[wasm_bindgen_test]
    async fn test_wasm_action_handler_collection() {
        // Create multiple handlers
        let handlers: Vec<Box<dyn ActionHandler>> = vec![
            Box::new(WasmActionHandler {
                call_count: Rc::new(RefCell::new(0)),
            }),
            Box::new(WasmActionHandler {
                call_count: Rc::new(RefCell::new(0)),
            }),
        ];

        // Verify we can iterate and call them
        for handler in handlers.iter() {
            let def = handler.definition();
            assert_eq!(def.name, "wasm_action");

            let memory = create_test_memory();

            let result = handler.handle(&memory, None, None).await.unwrap();
            assert!(result.is_some());
        }
    }

    // Test that ActionResult helper methods work
    #[wasm_bindgen_test]
    fn test_action_result_helpers() {
        let success = ActionResult::success();
        assert!(success.success);
        assert!(success.text.is_none());

        let success_text = ActionResult::success_with_text("done!");
        assert!(success_text.success);
        assert_eq!(success_text.text.unwrap(), "done!");

        let failure = ActionResult::failure("something went wrong");
        assert!(!failure.success);
        assert_eq!(failure.error.unwrap(), "something went wrong");
    }
}

// ========================================
// Platform Macros Tests (WASM)
// ========================================

mod platform_tests {
    use super::*;
    use elizaos::{define_platform_trait, platform_async_trait};

    // Test that define_platform_trait! works in WASM without Send + Sync
    define_platform_trait! {
        /// A WASM-compatible trait without bounds.
        pub trait WasmTestTrait {
            fn get_value(&self) -> i32;
        }
    }

    define_platform_trait! {
        /// A WASM-compatible trait with custom bounds.
        pub trait WasmTestTraitWithBounds [Clone] {
            fn get_name(&self) -> String;
        }
    }

    define_platform_trait! {
        /// A WASM-compatible trait with empty brackets.
        pub trait WasmTestTraitEmptyBrackets [] {
            fn get_id(&self) -> u32;
        }
    }

    #[derive(Clone)]
    struct WasmTestImpl {
        value: i32,
        name: String,
        id: u32,
    }

    impl WasmTestTrait for WasmTestImpl {
        fn get_value(&self) -> i32 {
            self.value
        }
    }

    impl WasmTestTraitWithBounds for WasmTestImpl {
        fn get_name(&self) -> String {
            self.name.clone()
        }
    }

    impl WasmTestTraitEmptyBrackets for WasmTestImpl {
        fn get_id(&self) -> u32 {
            self.id
        }
    }

    #[wasm_bindgen_test]
    fn test_wasm_define_platform_trait_no_bounds() {
        let t = WasmTestImpl {
            value: 42,
            name: "test".to_string(),
            id: 1,
        };
        assert_eq!(t.get_value(), 42);
    }

    #[wasm_bindgen_test]
    fn test_wasm_define_platform_trait_with_bounds() {
        let t = WasmTestImpl {
            value: 0,
            name: "hello".to_string(),
            id: 0,
        };
        assert_eq!(t.get_name(), "hello");

        // Test that Clone bound works
        let cloned = t.clone();
        assert_eq!(cloned.get_name(), "hello");
    }

    #[wasm_bindgen_test]
    fn test_wasm_define_platform_trait_empty_brackets() {
        let t = WasmTestImpl {
            value: 0,
            name: "".to_string(),
            id: 99,
        };
        assert_eq!(t.get_id(), 99);
    }

    // Test platform_async_trait! with async methods in WASM
    #[async_trait::async_trait(?Send)]
    pub trait WasmAsyncTrait {
        async fn process(&self, input: &str) -> String;
    }

    struct WasmAsyncImpl;

    platform_async_trait! {
        impl WasmAsyncTrait for WasmAsyncImpl {
            async fn process(&self, input: &str) -> String {
                format!("WASM processed: {}", input)
            }
        }
    }

    #[wasm_bindgen_test]
    async fn test_wasm_platform_async_trait() {
        let svc = WasmAsyncImpl;
        let result = svc.process("hello").await;
        assert_eq!(result, "WASM processed: hello");
    }

    // Test that non-Send types can be used in WASM traits
    // (This would fail on native due to Send + Sync bounds)
    use std::cell::RefCell;
    use std::rc::Rc;

    define_platform_trait! {
        /// A trait that uses non-Send types (only valid in WASM).
        pub trait NonSendTrait {
            fn get_rc_value(&self) -> i32;
        }
    }

    struct NonSendImpl {
        // Rc and RefCell are NOT Send + Sync, but that's fine in WASM
        value: Rc<RefCell<i32>>,
    }

    impl NonSendTrait for NonSendImpl {
        fn get_rc_value(&self) -> i32 {
            *self.value.borrow()
        }
    }

    #[wasm_bindgen_test]
    fn test_wasm_non_send_types_allowed() {
        let t = NonSendImpl {
            value: Rc::new(RefCell::new(100)),
        };
        assert_eq!(t.get_rc_value(), 100);

        // Modify through RefCell
        *t.value.borrow_mut() = 200;
        assert_eq!(t.get_rc_value(), 200);
    }

    // Test AnyArc type alias in WASM
    #[wasm_bindgen_test]
    fn test_wasm_any_arc() {
        use elizaos::platform::AnyArc;
        use std::sync::Arc;

        let value: AnyArc = Arc::new(42i32);
        // In WASM, AnyArc is Arc<dyn Any> - use downcast_ref
        let downcast_ref = value.downcast_ref::<i32>().unwrap();
        assert_eq!(*downcast_ref, 42);
    }

    // Test PlatformService trait bound in WASM
    #[wasm_bindgen_test]
    fn test_wasm_platform_service_bound() {
        use elizaos::platform::PlatformService;

        fn accepts_platform_service<T: PlatformService>(_: &T) {}

        // In WASM, any type should satisfy PlatformService (no bounds)
        let value = 42i32;
        accepts_platform_service(&value);

        // Even non-Send types should work
        let rc_value = Rc::new(42);
        accepts_platform_service(&rc_value);
    }
}

mod advanced_runtime_tests {
    use super::*;
    use elizaos::wasm::shims::JsModelHandler;
    use elizaos::wasm::{WasmAgentRuntime, WasmCharacter};
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
    async fn test_runtime_multiple_stop_calls() {
        let json = r#"{"name": "TestAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();

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

        assert_eq!(
            character.system(),
            Some("You are a helpful assistant".to_string())
        );
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

// ========================================
// Integration Tests - Full Runtime Flows
// ========================================

mod integration_tests_full {
    use super::*;
    use elizaos::wasm::shims::JsModelHandler;
    use elizaos::wasm::{generate_uuid, WasmAgentRuntime, WasmCharacter};
    use js_sys::Object;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;

    /// Test the full runtime lifecycle: create -> initialize -> use -> stop
    #[wasm_bindgen_test]
    async fn test_full_runtime_lifecycle() {
        // 1. Create runtime
        let json = r#"{
            "name": "LifecycleAgent",
            "bio": "An agent for testing the full lifecycle",
            "system": "You are a helpful assistant."
        }"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();

        // 2. Verify not initialized
        assert!(!runtime.is_initialized());
        assert_eq!(runtime.character_name(), "LifecycleAgent");

        // 3. Initialize
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();
        assert!(runtime.is_initialized());

        // 4. Register a model handler
        let code = r#"
            ({
                handle: async function(paramsJson) {
                    const params = JSON.parse(paramsJson);
                    return JSON.stringify({
                        text: "Hello from model! Prompt was: " + (params.prompt || "").substring(0, 30)
                    });
                }
            })
        "#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj).unwrap();
        runtime.register_model_handler("TEXT_LARGE", handler);

        // 5. Handle a message
        let entity_id = generate_uuid();
        let room_id = generate_uuid();
        let message_json = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{"text": "Hello agent!"}}
        }}"#,
            entity_id, room_id
        );

        let promise = runtime.handle_message(&message_json);
        let result = JsFuture::from(promise).await.unwrap();
        let result_str = result.as_string().unwrap();

        // 6. Verify response
        assert!(result_str.contains("didRespond"));
        assert!(result_str.contains("true"));
        assert!(result_str.contains("Hello from model"));

        // 7. Stop runtime
        runtime.stop();
        assert!(!runtime.is_initialized());
    }

    /// Test message handling with different content types
    #[wasm_bindgen_test]
    async fn test_message_handling_variations() {
        let json = r#"{"name": "MsgAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();

        // Register model handler that echoes the input
        let code = r#"
            ({
                handle: async function(paramsJson) {
                    const params = JSON.parse(paramsJson);
                    return JSON.stringify({
                        text: "Response to: " + (params.prompt || "unknown"),
                        receivedSystem: params.system || null
                    });
                }
            })
        "#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        let handler = JsModelHandler::new(obj).unwrap();
        runtime.register_model_handler("TEXT_LARGE", handler);

        // Test with empty content
        let msg1 = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{}}
        }}"#,
            generate_uuid(),
            generate_uuid()
        );
        let result1 = JsFuture::from(runtime.handle_message(&msg1)).await;
        assert!(result1.is_ok());

        // Test with text only
        let msg2 = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{"text": "Test message"}}
        }}"#,
            generate_uuid(),
            generate_uuid()
        );
        let result2 = JsFuture::from(runtime.handle_message(&msg2)).await;
        assert!(result2.is_ok());
        let result2_str = result2.unwrap().as_string().unwrap();
        assert!(result2_str.contains("Test message"));

        // Test with action in content
        let msg3 = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{"text": "Hello", "action": "REPLY"}}
        }}"#,
            generate_uuid(),
            generate_uuid()
        );
        let result3 = JsFuture::from(runtime.handle_message(&msg3)).await;
        assert!(result3.is_ok());

        runtime.stop();
    }

    /// Test multiple model handlers for different model types
    #[wasm_bindgen_test]
    async fn test_multiple_model_handlers() {
        let json = r#"{"name": "MultiModelAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();

        // Register TEXT_LARGE handler
        let code1 = r#"({ handle: async function(p) { return JSON.stringify({text: "TEXT_LARGE response"}); } })"#;
        let obj1: Object = js_sys::eval(code1).unwrap().dyn_into().unwrap();
        runtime.register_model_handler("TEXT_LARGE", JsModelHandler::new(obj1).unwrap());

        // Register TEXT_SMALL handler
        let code2 = r#"({ handle: async function(p) { return JSON.stringify({text: "TEXT_SMALL response"}); } })"#;
        let obj2: Object = js_sys::eval(code2).unwrap().dyn_into().unwrap();
        runtime.register_model_handler("TEXT_SMALL", JsModelHandler::new(obj2).unwrap());

        // Register EMBEDDING handler
        let code3 = r#"({ handle: async function(p) { return JSON.stringify({embedding: [0.1, 0.2, 0.3]}); } })"#;
        let obj3: Object = js_sys::eval(code3).unwrap().dyn_into().unwrap();
        runtime.register_model_handler("EMBEDDING", JsModelHandler::new(obj3).unwrap());

        // Send a message (uses TEXT_LARGE by default)
        let msg = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{"text": "Hello"}}
        }}"#,
            generate_uuid(),
            generate_uuid()
        );
        let result = JsFuture::from(runtime.handle_message(&msg)).await.unwrap();
        let result_str = result.as_string().unwrap();
        assert!(result_str.contains("TEXT_LARGE response"));

        runtime.stop();
    }

    /// Test error handling when model handler is not registered
    #[wasm_bindgen_test]
    async fn test_missing_model_handler_error() {
        let json = r#"{"name": "NoHandlerAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();

        // Don't register any handlers - try to send a message
        let msg = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{"text": "Hello"}}
        }}"#,
            generate_uuid(),
            generate_uuid()
        );

        let result = JsFuture::from(runtime.handle_message(&msg)).await;
        // Should fail because no TEXT_LARGE handler is registered
        assert!(result.is_err());

        runtime.stop();
    }

    /// Test runtime with complex character configuration
    #[wasm_bindgen_test]
    async fn test_complex_character_config() {
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "ComplexAgent",
            "bio": ["First line of bio", "Second line of bio", "Third line with details"],
            "system": "You are a complex agent with multiple capabilities. Always be helpful and concise.",
            "topics": ["technology", "science", "philosophy", "art"],
            "adjectives": ["intelligent", "friendly", "precise", "creative"],
            "style": {
                "all": ["Use clear language", "Be concise"],
                "chat": ["Engage naturally"],
                "post": ["Be professional"]
            }
        }"#;

        let runtime = WasmAgentRuntime::create(json).unwrap();

        // Verify character was parsed correctly
        assert_eq!(runtime.character_name(), "ComplexAgent");
        assert_eq!(runtime.agent_id(), "550e8400-e29b-41d4-a716-446655440000");

        let char_json = runtime.character().unwrap();
        assert!(char_json.contains("ComplexAgent"));
        assert!(char_json.contains("technology"));
        assert!(char_json.contains("intelligent"));

        // Initialize and verify it works
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();
        assert!(runtime.is_initialized());

        runtime.stop();
    }

    /// Test that the runtime preserves message IDs correctly
    #[wasm_bindgen_test]
    async fn test_message_id_preservation() {
        let json = r#"{"name": "IdAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();

        // Register handler
        let code =
            r#"({ handle: async function(p) { return JSON.stringify({text: "Response"}); } })"#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        runtime.register_model_handler("TEXT_LARGE", JsModelHandler::new(obj).unwrap());

        // Create message with specific IDs
        let entity_id = "11111111-1111-1111-1111-111111111111";
        let room_id = "22222222-2222-2222-2222-222222222222";
        let msg = format!(
            r#"{{
            "entityId": "{}",
            "roomId": "{}",
            "content": {{"text": "Hello"}}
        }}"#,
            entity_id, room_id
        );

        let result = JsFuture::from(runtime.handle_message(&msg)).await.unwrap();
        let result_str = result.as_string().unwrap();

        // Response should contain the room ID
        assert!(result_str.contains(room_id));

        runtime.stop();
    }

    /// Test concurrent message handling (sequential in WASM, but tests stability)
    #[wasm_bindgen_test]
    async fn test_sequential_message_handling() {
        let json = r#"{"name": "SeqAgent", "bio": "Test"}"#;
        let runtime = WasmAgentRuntime::create(json).unwrap();
        let promise = runtime.initialize();
        JsFuture::from(promise).await.unwrap();

        // Register handler with counter
        let code = r#"
            ({
                counter: 0,
                handle: async function(p) {
                    this.counter++;
                    return JSON.stringify({text: "Response #" + this.counter});
                }
            })
        "#;
        let obj: Object = js_sys::eval(code).unwrap().dyn_into().unwrap();
        runtime.register_model_handler("TEXT_LARGE", JsModelHandler::new(obj).unwrap());

        // Send multiple messages
        for i in 0..5 {
            let msg = format!(
                r#"{{
                "entityId": "{}",
                "roomId": "{}",
                "content": {{"text": "Message {}"}}
            }}"#,
                generate_uuid(),
                generate_uuid(),
                i
            );

            let result = JsFuture::from(runtime.handle_message(&msg)).await.unwrap();
            let result_str = result.as_string().unwrap();
            assert!(result_str.contains("Response #"));
        }

        runtime.stop();
    }
}
