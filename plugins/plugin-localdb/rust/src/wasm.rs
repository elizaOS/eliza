#![allow(missing_docs)]

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
use crate::schema::{
    AgentRow, CacheRow, EntityRow, LogRow, MemoryRow, ParticipantRow, RelationshipRow, RoomRow,
    TaskRow, WorldRow,
};

#[cfg(feature = "wasm")]
#[wasm_bindgen(start)]
pub fn init_wasm() {
    console_error_panic_hook::set_once();
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmMemoryRow {
    inner: MemoryRow,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmMemoryRow {
    /// Create a new memory row from JSON
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmMemoryRow, JsValue> {
        serde_json::from_str::<MemoryRow>(json)
            .map(|inner| WasmMemoryRow { inner })
            .map_err(|e| JsValue::from_str(&format!("Failed to parse MemoryRow: {}", e)))
    }

    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize MemoryRow: {}", e)))
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id.clone()
    }

    #[wasm_bindgen(getter, js_name = "entityId")]
    pub fn entity_id(&self) -> String {
        self.inner.entity_id.clone()
    }

    #[wasm_bindgen(getter, js_name = "roomId")]
    pub fn room_id(&self) -> String {
        self.inner.room_id.clone()
    }

    #[wasm_bindgen(getter, js_name = "agentId")]
    pub fn agent_id(&self) -> String {
        self.inner.agent_id.clone()
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmAgentRow {
    inner: AgentRow,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmAgentRow {
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmAgentRow, JsValue> {
        serde_json::from_str::<AgentRow>(json)
            .map(|inner| WasmAgentRow { inner })
            .map_err(|e| JsValue::from_str(&format!("Failed to parse AgentRow: {}", e)))
    }

    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize AgentRow: {}", e)))
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.inner.name.clone()
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmEntityRow {
    inner: EntityRow,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmEntityRow {
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmEntityRow, JsValue> {
        serde_json::from_str::<EntityRow>(json)
            .map(|inner| WasmEntityRow { inner })
            .map_err(|e| JsValue::from_str(&format!("Failed to parse EntityRow: {}", e)))
    }

    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize EntityRow: {}", e)))
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id.clone()
    }
}

/// WASM-compatible RoomRow wrapper
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmRoomRow {
    inner: RoomRow,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmRoomRow {
    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<WasmRoomRow, JsValue> {
        serde_json::from_str::<RoomRow>(json)
            .map(|inner| WasmRoomRow { inner })
            .map_err(|e| JsValue::from_str(&format!("Failed to parse RoomRow: {}", e)))
    }

    #[wasm_bindgen(js_name = "toJson")]
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize RoomRow: {}", e)))
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id.clone()
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "testMemoryRowRoundTrip")]
pub fn test_memory_row_round_trip(json: &str) -> Result<bool, JsValue> {
    let row = WasmMemoryRow::from_json(json)?;
    let serialized = row.to_json()?;
    let reparsed = WasmMemoryRow::from_json(&serialized)?;
    let reserialized = reparsed.to_json()?;

    Ok(serialized == reserialized)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "testAgentRowRoundTrip")]
pub fn test_agent_row_round_trip(json: &str) -> Result<bool, JsValue> {
    let row = WasmAgentRow::from_json(json)?;
    let serialized = row.to_json()?;
    let reparsed = WasmAgentRow::from_json(&serialized)?;
    let reserialized = reparsed.to_json()?;

    Ok(serialized == reserialized)
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = "getVersion")]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
