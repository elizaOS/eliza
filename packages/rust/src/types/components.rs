//! Component types (proto-backed) with runtime helpers.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

pub use super::generated::eliza::v1::{ActionExample, ActionParameter, ActionParameterSchema, EvaluationExample};
use super::memory::Memory;
use super::primitives::Content;
use super::state::State;

pub type ActionParameters = HashMap<String, JsonValue>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionContext {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_results: Vec<ActionResult>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_context: Option<ActionContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_plan_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<ActionParameters>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<ActionParameters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ActionParameters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<ActionParameters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ActionParameters>,
}

fn insert_map_value(target: &mut Option<ActionParameters>, key: String, value: JsonValue) {
    let map = target.get_or_insert_with(HashMap::new);
    map.insert(key, value);
}

impl ActionResult {
    pub fn success(message: impl Into<String>) -> Self {
        ActionResult {
            success: true,
            text: Some(message.into()),
            values: None,
            data: None,
            error: None,
        }
    }

    pub fn success_with_text(message: &str) -> Self {
        ActionResult {
            success: true,
            text: Some(message.to_string()),
            values: None,
            data: None,
            error: None,
        }
    }

    pub fn failure(message: &str) -> Self {
        ActionResult {
            success: false,
            text: None,
            values: None,
            data: None,
            error: Some(message.to_string()),
        }
    }

    pub fn with_value(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.values, key.into(), value.into());
        self
    }

    pub fn with_data(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.data, key.into(), value.into());
        self
    }
}

impl ProviderResult {
    pub fn new(text: impl Into<String>) -> Self {
        ProviderResult {
            text: Some(text.into()),
            values: None,
            data: None,
        }
    }

    pub fn with_text(text: impl Into<String>) -> Self {
        ProviderResult {
            text: Some(text.into()),
            values: None,
            data: None,
        }
    }

    pub fn empty() -> Self {
        ProviderResult::new("")
    }

    pub fn with_value(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.values, key.into(), value.into());
        self
    }

    pub fn with_data(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.data, key.into(), value.into());
        self
    }
}


// Runtime definitions (not in proto)
#[derive(Clone, Debug)]
pub struct ActionDefinition {
    pub name: String,
    pub description: String,
    pub similes: Option<Vec<String>>,
    pub examples: Option<Vec<Vec<ActionExample>>>,
    pub priority: Option<i32>,
    pub tags: Option<Vec<String>>,
    pub parameters: Option<Vec<ActionParameter>>,
}

#[derive(Clone, Debug)]
pub struct ProviderDefinition {
    pub name: String,
    pub description: Option<String>,
    pub dynamic: Option<bool>,
    pub position: Option<i32>,
    pub private: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct EvaluatorDefinition {
    pub name: String,
    pub description: String,
    pub always_run: Option<bool>,
    pub similes: Option<Vec<String>>,
    pub examples: Vec<EvaluationExample>,
}

pub type HandlerCallback = Box<
    dyn Fn(Content) -> Pin<Box<dyn Future<Output = Vec<Memory>> + Send + 'static>>
        + Send
        + Sync,
>;

pub type StreamChunkCallback =
    Box<dyn Fn(&str, Option<&str>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[async_trait]
pub trait ActionHandler: Send + Sync {
    fn definition(&self) -> ActionDefinition;
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error>;
}

#[async_trait]
pub trait ProviderHandler: Send + Sync {
    fn definition(&self) -> ProviderDefinition;
    async fn get(&self, message: &Memory, state: &State) -> Result<ProviderResult, anyhow::Error>;
}

#[async_trait]
pub trait EvaluatorHandler: Send + Sync {
    fn definition(&self) -> EvaluatorDefinition;
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error>;
}

