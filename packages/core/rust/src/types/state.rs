//! State types for elizaOS
//!
//! Contains State, StateData, and related types for runtime state management.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::{ActionPlan, ActionResult, Entity, Room, World};

/// Structured data cached in state by providers and actions
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateData {
    /// Cached room data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<Room>,
    /// Cached world data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world: Option<World>,
    /// Cached entity data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<Entity>,
    /// Provider results cache
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<HashMap<String, HashMap<String, serde_json::Value>>>,
    /// Current action plan
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_plan: Option<ActionPlan>,
    /// Results from previous actions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_results: Option<Vec<ActionResult>>,
    /// Additional dynamic properties
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Represents the current state or context of a conversation
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Key-value store for general state variables
    pub values: HashMap<String, serde_json::Value>,
    /// Structured data cache
    pub data: StateData,
    /// String representation of current context
    pub text: String,
    /// Additional dynamic properties
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl State {
    /// Create a new empty state
    pub fn new() -> Self {
        State::default()
    }

    /// Create a state with the given text
    pub fn with_text(text: &str) -> Self {
        State {
            text: text.to_string(),
            ..Default::default()
        }
    }

    /// Set a value in the state
    pub fn set_value(&mut self, key: &str, value: serde_json::Value) {
        self.values.insert(key.to_string(), value);
    }

    /// Get a value from the state
    pub fn get_value(&self, key: &str) -> Option<&serde_json::Value> {
        self.values.get(key)
    }

    /// Get a string value from the state
    pub fn get_string(&self, key: &str) -> Option<&str> {
        self.values.get(key).and_then(|v| v.as_str())
    }

    /// Get a bool value from the state
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.values.get(key).and_then(|v| v.as_bool())
    }

    /// Get an i64 value from the state
    pub fn get_i64(&self, key: &str) -> Option<i64> {
        self.values.get(key).and_then(|v| v.as_i64())
    }

    /// Merge another state into this one
    pub fn merge(&mut self, other: State) {
        for (k, v) in other.values {
            self.values.insert(k, v);
        }
        if !other.text.is_empty() {
            self.text = other.text;
        }
        for (k, v) in other.extra {
            self.extra.insert(k, v);
        }
    }

    /// Set the room in state data
    pub fn set_room(&mut self, room: Room) {
        self.data.room = Some(room);
    }

    /// Set the world in state data
    pub fn set_world(&mut self, world: World) {
        self.data.world = Some(world);
    }

    /// Set the entity in state data
    pub fn set_entity(&mut self, entity: Entity) {
        self.data.entity = Some(entity);
    }

    /// Add an action result
    pub fn add_action_result(&mut self, result: ActionResult) {
        if let Some(ref mut results) = self.data.action_results {
            results.push(result);
        } else {
            self.data.action_results = Some(vec![result]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_creation() {
        let state = State::with_text("Hello, world!");
        assert_eq!(state.text, "Hello, world!");
    }

    #[test]
    fn test_state_values() {
        let mut state = State::new();
        state.set_value("name", serde_json::json!("Alice"));
        state.set_value("age", serde_json::json!(30));
        state.set_value("active", serde_json::json!(true));

        assert_eq!(state.get_string("name"), Some("Alice"));
        assert_eq!(state.get_i64("age"), Some(30));
        assert_eq!(state.get_bool("active"), Some(true));
    }

    #[test]
    fn test_state_serialization() {
        let mut state = State::with_text("Test context");
        state.set_value("key", serde_json::json!("value"));

        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"text\":\"Test context\""));
        assert!(json.contains("\"key\":\"value\""));
    }
}
