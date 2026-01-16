//! State types (proto-backed) with helpers for dynamic values.

use prost_types::{value::Kind, Struct, Value};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

pub use super::generated::eliza::v1::{
    ActionPlan, ActionPlanStep, ProviderCacheEntry, State, StateData, StateValues,
    WorkingMemoryItem,
};
use super::components::ActionResult;
use super::environment::{Entity, Room, World};

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
        fields: HashMap::new(),
    })
}

impl State {
    pub fn new() -> Self {
        State {
            values: Some(StateValues::default()),
            data: Some(StateData::default()),
            text: String::new(),
            extra: None,
        }
    }

    pub fn with_text(text: &str) -> Self {
        let mut state = State::new();
        state.text = text.to_string();
        state
    }

    pub fn get_value(&self, key: &str) -> Option<JsonValue> {
        let values = self.values.as_ref()?;
        let extra = values.extra.as_ref()?;
        extra.fields.get(key).map(json_from_prost_value)
    }

    pub fn set_value(&mut self, key: &str, value: JsonValue) {
        let values = self.values.get_or_insert_with(StateValues::default);
        let extra = ensure_struct(&mut values.extra);
        extra
            .fields
            .insert(key.to_string(), prost_value_from_json(value));
    }

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

    pub fn merge_values_struct(&mut self, values: &Struct) {
        for (k, v) in &values.fields {
            self.set_value(k, json_from_prost_value(v));
        }
    }

    pub fn data_mut(&mut self) -> &mut StateData {
        self.data.get_or_insert_with(StateData::default)
    }

    pub fn data_ref(&self) -> Option<&StateData> {
        self.data.as_ref()
    }

    pub fn set_room(&mut self, room: Room) {
        self.data_mut().room = Some(room);
    }

    pub fn set_world(&mut self, world: World) {
        self.data_mut().world = Some(world);
    }

    pub fn set_entity(&mut self, entity: Entity) {
        self.data_mut().entity = Some(entity);
    }

    pub fn add_action_result(&mut self, result: ActionResult) {
        let data = self.data_mut();
        if let Some(results) = &mut data.action_results {
            results.push(result);
        } else {
            data.action_results = Some(vec![result]);
        }
    }

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
