//! State types (proto-backed) with helpers for dynamic values.

use prost_types::{value::Kind, Struct, Value};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, HashMap};

pub use super::generated::eliza::v1::{
    ActionPlan, ActionPlanStep, ProviderCacheEntry, State, StateData, StateValues,
    WorkingMemoryItem,
};
// Use proto types that match StateData fields
use super::generated::eliza::v1::{
    ActionResult as ProtoActionResult, Entity as ProtoEntity, Room as ProtoRoom,
    World as ProtoWorld,
};

fn prost_value_from_json(value: JsonValue) -> Value {
    let kind = match value {
        JsonValue::Null => Kind::NullValue(0),
        JsonValue::Bool(v) => Kind::BoolValue(v),
        JsonValue::Number(n) => Kind::NumberValue(n.as_f64().unwrap_or(0.0)),
        JsonValue::String(s) => Kind::StringValue(s),
        JsonValue::Array(items) => Kind::ListValue(prost_types::ListValue {
            values: items.into_iter().map(prost_value_from_json).collect(),
        }),
        JsonValue::Object(map) => Kind::StructValue(Struct {
            fields: map
                .into_iter()
                .map(|(k, v)| (k, prost_value_from_json(v)))
                .collect(),
        }),
    };
    Value { kind: Some(kind) }
}

fn json_from_prost_value(value: &Value) -> JsonValue {
    match value.kind.as_ref() {
        Some(Kind::NullValue(_)) => JsonValue::Null,
        Some(Kind::BoolValue(v)) => JsonValue::Bool(*v),
        Some(Kind::NumberValue(v)) => JsonValue::Number(
            serde_json::Number::from_f64(*v).unwrap_or_else(|| serde_json::Number::from(0)),
        ),
        Some(Kind::StringValue(v)) => JsonValue::String(v.clone()),
        Some(Kind::StructValue(s)) => JsonValue::Object(
            s.fields
                .iter()
                .map(|(k, v)| (k.clone(), json_from_prost_value(v)))
                .collect(),
        ),
        Some(Kind::ListValue(list)) => {
            JsonValue::Array(list.values.iter().map(json_from_prost_value).collect())
        }
        None => JsonValue::Null,
    }
}

fn ensure_struct(target: &mut Option<Struct>) -> &mut Struct {
    target.get_or_insert_with(|| Struct {
        fields: BTreeMap::new(),
    })
}

impl State {
    /// Creates a new empty state with default values.
    pub fn new() -> Self {
        State {
            values: Some(StateValues::default()),
            data: Some(StateData::default()),
            text: String::new(),
            extra: None,
        }
    }

    /// Creates a new state with the given text content.
    pub fn with_text(text: &str) -> Self {
        let mut state = State::new();
        state.text = text.to_string();
        state
    }

    /// Gets a value from the state's values map by key.
    pub fn get_value(&self, key: &str) -> Option<JsonValue> {
        let values = self.values.as_ref()?;
        let extra = values.extra.as_ref()?;
        extra.fields.get(key).map(json_from_prost_value)
    }

    /// Sets a value in the state's values map.
    pub fn set_value(&mut self, key: &str, value: JsonValue) {
        let values = self.values.get_or_insert_with(StateValues::default);
        let extra = ensure_struct(&mut values.extra);
        extra
            .fields
            .insert(key.to_string(), prost_value_from_json(value));
    }

    /// Returns all values as a HashMap.
    pub fn values_map(&self) -> HashMap<String, JsonValue> {
        let mut out = HashMap::new();
        if let Some(values) = &self.values {
            if let Some(extra) = &values.extra {
                for (k, v) in &extra.fields {
                    out.insert(k.clone(), json_from_prost_value(v));
                }
            }
        }
        out
    }

    /// Merges values from a prost Struct into the state.
    pub fn merge_values_struct(&mut self, values: &Struct) {
        for (k, v) in &values.fields {
            self.set_value(k, json_from_prost_value(v));
        }
    }

    /// Merge values from a HashMap of JSON values into state.
    pub fn merge_values_json(&mut self, values: &HashMap<String, JsonValue>) {
        for (k, v) in values {
            self.set_value(k, v.clone());
        }
    }

    /// Returns a mutable reference to the state data, creating it if needed.
    pub fn data_mut(&mut self) -> &mut StateData {
        self.data.get_or_insert_with(StateData::default)
    }

    /// Returns an optional reference to the state data.
    pub fn data_ref(&self) -> Option<&StateData> {
        self.data.as_ref()
    }

    /// Sets the room in the state data.
    pub fn set_room(&mut self, room: ProtoRoom) {
        self.data_mut().room = Some(room);
    }

    /// Sets the world in the state data.
    pub fn set_world(&mut self, world: ProtoWorld) {
        self.data_mut().world = Some(world);
    }

    /// Sets the entity in the state data.
    pub fn set_entity(&mut self, entity: ProtoEntity) {
        self.data_mut().entity = Some(entity);
    }

    /// Adds an action result to the state data.
    pub fn add_action_result(&mut self, result: ProtoActionResult) {
        let data = self.data_mut();
        data.action_results.push(result);
    }

    /// Merges another state into this one.
    pub fn merge(&mut self, other: State) {
        for (k, v) in other.values_map() {
            self.set_value(&k, v);
        }
        if !other.text.is_empty() {
            self.text = other.text;
        }
        if let Some(extra) = other.extra {
            let target = ensure_struct(&mut self.extra);
            for (k, v) in extra.fields {
                target.fields.insert(k, v);
            }
        }
    }
}
