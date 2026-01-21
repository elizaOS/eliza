//! WASM bindings for elizaOS core
//!
//! This module provides JavaScript/TypeScript and Python bindings for the elizaOS
//! core types and functionality through WebAssembly.

pub mod error;
pub mod shims;

pub use error::{WasmError, WasmResultExt};
pub use shims::JsModelHandler;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
use wasm_bindgen_futures::future_to_promise;

#[cfg(feature = "wasm")]
use js_sys::{Function, Object, Promise, Reflect};

#[cfg(feature = "wasm")]
use crate::types::{Agent, Character, Content, Entity, Memory, Plugin, Room, UUID};

/// Initialize the WASM module with panic hook for better error messages
#[cfg(feature = "wasm")]
#[wasm_bindgen(start)]
pub fn init_wasm() {
    console_error_panic_hook::set_once();
}

/// WASM-compatible UUID type wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmUUID {
    inner: UUID,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmUUID {
    /// Create a new random UUID
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: UUID::new_v4(),
        }
    }

    /// Create a UUID from a string
    #[wasm_bindgen(js_name = "fromString")]
    pub fn from_string(s: &str) -> Result<WasmUUID, JsValue> {
        UUID::new(s).map(|inner| WasmUUID { inner }).map_err(|e| {
            WasmError::validation_error(format!("Invalid UUID: {}", e), Some("uuid".to_string()))
                .into_js_value()
        })
    }

    /// Convert to string
    #[wasm_bindgen(js_name = "toString")]
    pub fn to_string_js(&self) -> String {
        self.inner.to_string()
    }
}

#[cfg(feature = "wasm")]
impl Default for WasmUUID {
    fn default() -> Self {
        Self::new()
    }
}

/// WASM-compatible Memory wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmMemory {
    inner: Memory,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmMemory {
    /// Create a new memory from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmMemory, JsValue> {
        serde_json::from_str::<Memory>(json)
            .map(|inner| WasmMemory { inner })
            .map_err(|e| WasmError::from_json_error(&e, Some("memory".to_string())).into_js_value())
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize Memory: {}", e), None)
                .into_js_value()
        })
    }

    /// Get the memory ID
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> Option<String> {
        self.inner.id.as_ref().map(|id| id.to_string())
    }

    /// Get the entity ID
    #[wasm_bindgen(getter, js_name = "entityId")]
    pub fn entity_id(&self) -> String {
        self.inner.entity_id.to_string()
    }

    /// Get the room ID
    #[wasm_bindgen(getter, js_name = "roomId")]
    pub fn room_id(&self) -> String {
        self.inner.room_id.to_string()
    }

    /// Get the content as JSON
    #[wasm_bindgen(getter)]
    pub fn content(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.content).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize content: {}", e), None)
                .into_js_value()
        })
    }

    /// Check if memory is unique
    #[wasm_bindgen(getter)]
    pub fn unique(&self) -> bool {
        self.inner.unique.unwrap_or(false)
    }

    /// Get created_at timestamp
    #[wasm_bindgen(getter, js_name = "createdAt")]
    pub fn created_at(&self) -> Option<f64> {
        self.inner.created_at.map(|t| t as f64)
    }
}

/// WASM-compatible Character wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmCharacter {
    inner: Character,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmCharacter {
    /// Create a new character from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmCharacter, JsValue> {
        serde_json::from_str::<Character>(json)
            .map(|inner| WasmCharacter { inner })
            .map_err(|e| {
                WasmError::from_json_error(&e, Some("character".to_string())).into_js_value()
            })
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize Character: {}", e), None)
                .into_js_value()
        })
    }

    /// Get the character name
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.inner.name.clone()
    }

    /// Get the system prompt
    #[wasm_bindgen(getter)]
    pub fn system(&self) -> Option<String> {
        self.inner.system.clone()
    }

    /// Get topics as JSON array
    #[wasm_bindgen(getter)]
    pub fn topics(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.topics).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize topics: {}", e), None)
                .into_js_value()
        })
    }

    /// Get the bio
    #[wasm_bindgen(getter)]
    pub fn bio(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.bio).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize bio: {}", e), None).into_js_value()
        })
    }
}

/// WASM-compatible Agent wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmAgent {
    inner: Agent,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmAgent {
    /// Create a new agent from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmAgent, JsValue> {
        serde_json::from_str::<Agent>(json)
            .map(|inner| WasmAgent { inner })
            .map_err(|e| WasmError::from_json_error(&e, Some("agent".to_string())).into_js_value())
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize Agent: {}", e), None)
                .into_js_value()
        })
    }

    /// Get the agent ID
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> Option<String> {
        self.inner.character.id.as_ref().map(|id| id.to_string())
    }

    /// Get the agent name
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.inner.character.name.clone()
    }
}

/// WASM-compatible Plugin wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmPlugin {
    inner: Plugin,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmPlugin {
    /// Create a new plugin from JSON (only definition is serialized)
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmPlugin, JsValue> {
        use crate::types::{Plugin, PluginDefinition};
        let definition: PluginDefinition = serde_json::from_str(json).map_err(|e| {
            WasmError::from_json_error(&e, Some("pluginDefinition".to_string())).into_js_value()
        })?;
        Ok(WasmPlugin {
            inner: Plugin {
                definition,
                action_handlers: vec![],
                provider_handlers: vec![],
                evaluator_handlers: vec![],
                model_handlers: std::collections::HashMap::new(),
                tests: vec![],
                init: None,
            },
        })
    }

    /// Convert to JSON (only definition is serialized)
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.definition).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize PluginDefinition: {}", e), None)
                .into_js_value()
        })
    }

    /// Get the plugin name
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.inner.name().to_string()
    }

    /// Get the plugin description
    #[wasm_bindgen(getter)]
    pub fn description(&self) -> Option<String> {
        Some(self.inner.description().to_string())
    }
}

/// WASM-compatible Room wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmRoom {
    inner: Room,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmRoom {
    /// Create a new room from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmRoom, JsValue> {
        serde_json::from_str::<Room>(json)
            .map(|inner| WasmRoom { inner })
            .map_err(|e| WasmError::from_json_error(&e, Some("room".to_string())).into_js_value())
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize Room: {}", e), None).into_js_value()
        })
    }

    /// Get the room ID
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id.to_string()
    }
}

/// WASM-compatible Entity wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmEntity {
    inner: Entity,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmEntity {
    /// Create a new entity from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmEntity, JsValue> {
        serde_json::from_str::<Entity>(json)
            .map(|inner| WasmEntity { inner })
            .map_err(|e| WasmError::from_json_error(&e, Some("entity".to_string())).into_js_value())
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize Entity: {}", e), None)
                .into_js_value()
        })
    }

    /// Get the entity ID
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> Option<String> {
        self.inner.id.as_ref().map(|id| id.to_string())
    }
}

// ========================================
// Utility functions
// ========================================

/// Parse a character JSON string and validate it
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "parseCharacter")]
pub fn parse_character(json: &str) -> Result<WasmCharacter, JsValue> {
    WasmCharacter::from_json(json)
}

/// Parse a memory JSON string
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "parseMemory")]
pub fn parse_memory(json: &str) -> Result<WasmMemory, JsValue> {
    WasmMemory::from_json(json)
}

/// Validate a UUID string
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "validateUUID")]
pub fn validate_uuid(uuid_str: &str) -> bool {
    uuid::Uuid::parse_str(uuid_str).is_ok()
}

/// Generate a new UUID
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "generateUUID")]
pub fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Convert a string to a deterministic UUID (similar to stringToUuid in TS)
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "stringToUuid")]
pub fn string_to_uuid(input: &str) -> String {
    crate::types::string_to_uuid(input).to_string()
}

/// Get the version of the elizaOS core
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ========================================
// WasmAgentRuntime - Rust agent runtime accessible from JS
// ========================================

#[cfg(feature = "wasm")]
use std::cell::RefCell;

#[cfg(feature = "wasm")]
use std::collections::HashMap;

// Thread-local storage for JS model handlers
// Since WASM is single-threaded, this is safe
#[cfg(feature = "wasm")]
thread_local! {
    static JS_MODEL_HANDLERS: RefCell<HashMap<String, JsModelHandler>> = RefCell::new(HashMap::new());
}

/// Call a JS model handler by name
#[cfg(feature = "wasm")]
async fn call_js_model_handler(
    model_type: &str,
    params: serde_json::Value,
) -> Result<String, JsValue> {
    let handler = JS_MODEL_HANDLERS.with(|handlers| handlers.borrow().get(model_type).cloned());

    let handler = handler.ok_or_else(|| {
        WasmError::not_found(
            format!("No JS handler registered for model type: {}", model_type),
            Some("model_type".to_string()),
        )
        .into_js_value()
    })?;

    handler.call(&params).await.map_err(|e| e.into_js_value())
}

/// WASM-compatible AgentRuntime
///
/// This is a standalone WASM runtime that doesn't depend on the native AgentRuntime.
/// It provides basic message handling by delegating to JavaScript model handlers.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmAgentRuntime {
    character: RefCell<Character>,
    agent_id: UUID,
    initialized: RefCell<bool>,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmAgentRuntime {
    /// Create a new WasmAgentRuntime from a character JSON string
    ///
    /// This creates the runtime wrapper but does not initialize it.
    #[wasm_bindgen(js_name = "create")]
    pub fn create(character_json: &str) -> Result<WasmAgentRuntime, JsValue> {
        let character: Character = serde_json::from_str(character_json).map_err(|e| {
            WasmError::from_json_error(&e, Some("character".to_string())).into_js_value()
        })?;

        let agent_id = character
            .id
            .clone()
            .unwrap_or_else(|| crate::types::string_to_uuid(&character.name));

        Ok(WasmAgentRuntime {
            character: RefCell::new(character),
            agent_id,
            initialized: RefCell::new(false),
        })
    }

    /// Initialize the runtime.
    #[wasm_bindgen]
    pub fn initialize(&self) -> Result<(), JsValue> {
        *self.initialized.borrow_mut() = true;
        Ok(())
    }

    /// Check if the runtime has been initialized.
    #[wasm_bindgen(getter, js_name = "isInitialized")]
    pub fn is_initialized(&self) -> bool {
        *self.initialized.borrow()
    }

    /// Register a model handler using the shim.
    #[wasm_bindgen(js_name = "registerModelHandler")]
    pub fn register_model_handler(&self, model_type: &str, handler: JsModelHandler) {
        JS_MODEL_HANDLERS.with(|handlers| {
            handlers
                .borrow_mut()
                .insert(model_type.to_string(), handler);
        });
    }

    /// Register a model handler from a raw JavaScript function.
    #[wasm_bindgen(js_name = "registerModelHandlerFn")]
    pub fn register_model_handler_fn(
        &self,
        model_type: &str,
        handler: Function,
    ) -> Result<(), JsValue> {
        let obj = Object::new();
        Reflect::set(&obj, &JsValue::from_str("handle"), &handler)?;
        let shim = JsModelHandler::new(obj)?;
        self.register_model_handler(model_type, shim);
        Ok(())
    }

    /// Handle an incoming message
    #[wasm_bindgen(js_name = "handleMessage")]
    pub fn handle_message(&self, message_json: &str) -> Promise {
        let message_result: Result<Memory, _> = serde_json::from_str(message_json);
        let character = self.character.borrow().clone();
        let agent_id = self.agent_id.clone();
        let initialized = *self.initialized.borrow();

        future_to_promise(async move {
            if !initialized {
                return Err(WasmError::not_initialized("Runtime not initialized").into_js_value());
            }

            let message = message_result.map_err(|e| {
                WasmError::from_json_error(&e, Some("message".to_string())).into_js_value()
            })?;

            // Extract user text from message
            let user_text = message.content.text.as_deref().unwrap_or("");

            // Build prompt
            let prompt = format!("User: {}\n{}:", user_text, character.name);

            // Call the model handler
            let params = serde_json::json!({
                "prompt": prompt,
                "system": character.system,
                "temperature": 0.7
            });

            let response_text = call_js_model_handler("TEXT_LARGE", params).await?;

            // Create response content
            let response_content = Content {
                text: Some(response_text.clone()),
                ..Default::default()
            };

            // Create response memory
            let response_memory = Memory {
                id: Some(UUID::new_v4()),
                entity_id: agent_id.clone(),
                agent_id: Some(agent_id),
                room_id: message.room_id.clone(),
                content: response_content.clone(),
                created_at: Some(js_sys::Date::now() as i64),
                embedding: None,
                world_id: None,
                unique: Some(true),
                similarity: None,
                metadata: None,
            };

            // Build response
            let response = serde_json::json!({
                "didRespond": true,
                "responseContent": response_content,
                "responseMessages": [response_memory],
            });

            let json = serde_json::to_string(&response).map_err(|e| {
                WasmError::parse_error(format!("Failed to serialize response: {}", e), None)
                    .into_js_value()
            })?;

            Ok(JsValue::from_str(&json))
        })
    }

    /// Get the agent ID
    #[wasm_bindgen(getter, js_name = "agentId")]
    pub fn agent_id(&self) -> String {
        self.agent_id.to_string()
    }

    /// Get the character name
    #[wasm_bindgen(getter, js_name = "characterName")]
    pub fn character_name(&self) -> String {
        self.character.borrow().name.clone()
    }

    /// Get the character as JSON
    #[wasm_bindgen(getter, js_name = "character")]
    pub fn character(&self) -> Result<String, JsValue> {
        serde_json::to_string(&*self.character.borrow()).map_err(|e| {
            WasmError::parse_error(format!("Failed to serialize character: {}", e), None)
                .into_js_value()
        })
    }

    /// Stop the runtime
    #[wasm_bindgen]
    pub fn stop(&self) {
        // Clear JS model handlers
        JS_MODEL_HANDLERS.with(|handlers| {
            handlers.borrow_mut().clear();
        });
        *self.initialized.borrow_mut() = false;
    }
}

// ========================================
// Interop test helpers
// ========================================

/// Test serialization round-trip for Memory
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "testMemoryRoundTrip")]
pub fn test_memory_round_trip(json: &str) -> Result<bool, JsValue> {
    let memory = WasmMemory::from_json(json)?;
    let serialized = memory.to_json()?;
    let reparsed = WasmMemory::from_json(&serialized)?;
    let reserialized = reparsed.to_json()?;

    // Compare the final serialization
    Ok(serialized == reserialized)
}

/// Test serialization round-trip for Character
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "testCharacterRoundTrip")]
pub fn test_character_round_trip(json: &str) -> Result<bool, JsValue> {
    let character = WasmCharacter::from_json(json)?;
    let serialized = character.to_json()?;
    let reparsed = WasmCharacter::from_json(&serialized)?;
    let reserialized = reparsed.to_json()?;

    Ok(serialized == reserialized)
}

/// Test serialization round-trip for Agent
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "testAgentRoundTrip")]
pub fn test_agent_round_trip(json: &str) -> Result<bool, JsValue> {
    let agent = WasmAgent::from_json(json)?;
    let serialized = agent.to_json()?;
    let reparsed = WasmAgent::from_json(&serialized)?;
    let reserialized = reparsed.to_json()?;

    Ok(serialized == reserialized)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use crate::types::UUID;

    #[test]
    fn test_uuid_generation() {
        let uuid1 = uuid::Uuid::new_v4().to_string();
        let uuid2 = uuid::Uuid::new_v4().to_string();
        assert_ne!(uuid1, uuid2);
    }

    #[test]
    fn test_string_to_uuid_deterministic() {
        let uuid1 = crate::types::string_to_uuid("test").to_string();
        let uuid2 = crate::types::string_to_uuid("test").to_string();
        assert_eq!(uuid1, uuid2);
        assert_eq!(uuid1, "a94a8fe5-ccb1-0ba6-9c4c-0873d391e987");
    }
}
