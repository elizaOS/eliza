//! WASM bindings for elizaOS core
//!
//! This module provides JavaScript/TypeScript and Python bindings for the elizaOS
//! core types and functionality through WebAssembly.

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
use crate::types::{Agent, Character, Entity, Memory, Plugin, Room, State, UUID};

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
        UUID::new(s)
            .map(|inner| WasmUUID { inner })
            .map_err(|e| JsValue::from_str(&format!("Invalid UUID: {}", e)))
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
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Memory: {}", e)))
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize Memory: {}", e)))
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
        serde_json::to_string(&self.inner.content)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize content: {}", e)))
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
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Character: {}", e)))
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize Character: {}", e)))
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
        serde_json::to_string(&self.inner.topics)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize topics: {}", e)))
    }

    /// Get the bio
    #[wasm_bindgen(getter)]
    pub fn bio(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.bio)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize bio: {}", e)))
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
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Agent: {}", e)))
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize Agent: {}", e)))
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
        let definition: PluginDefinition = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse PluginDefinition: {}", e)))?;
        Ok(WasmPlugin {
            inner: Plugin {
                definition,
                action_handlers: vec![],
                provider_handlers: vec![],
                evaluator_handlers: vec![],
                tests: vec![],
                init: None,
            },
        })
    }

    /// Convert to JSON (only definition is serialized)
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.definition)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize PluginDefinition: {}", e)))
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

/// WASM-compatible State wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmState {
    inner: State,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmState {
    /// Create a new state from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmState, JsValue> {
        serde_json::from_str::<State>(json)
            .map(|inner| WasmState { inner })
            .map_err(|e| JsValue::from_str(&format!("Failed to parse State: {}", e)))
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize State: {}", e)))
    }

    /// Create empty state
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: State::default(),
        }
    }
}

#[cfg(feature = "wasm")]
impl Default for WasmState {
    fn default() -> Self {
        Self::new()
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
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Room: {}", e)))
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize Room: {}", e)))
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
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Entity: {}", e)))
    }

    /// Convert to JSON
    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize Entity: {}", e)))
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
    // Use UUID v5 with a fixed namespace for deterministic generation
    use uuid::Uuid;
    let namespace = Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();
    Uuid::new_v5(&namespace, input.as_bytes()).to_string()
}

/// Get the version of the elizaOS core
#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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
        let namespace = uuid::Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();
        let uuid1 = uuid::Uuid::new_v5(&namespace, "test".as_bytes()).to_string();
        let uuid2 = uuid::Uuid::new_v5(&namespace, "test".as_bytes()).to_string();
        assert_eq!(uuid1, uuid2);
    }
}
