#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct TextGenerationParams {
    pub prompt: String,
    pub system: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub top_k: Option<u32>,
    pub stop: Option<Vec<String>>,
}

impl TextGenerationParams {
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            ..Default::default()
        }
    }

    pub fn with_system<S: Into<String>>(mut self, system: S) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    pub fn with_top_p(mut self, top_p: f32) -> Self {
        self.top_p = Some(top_p);
        self
    }
}

#[derive(Debug, Clone)]
pub struct TextGenerationResponse {
    pub text: String,
    pub model: String,
    pub done: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ObjectGenerationParams {
    pub prompt: String,
    pub system: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub schema: Option<serde_json::Value>,
}

impl ObjectGenerationParams {
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            temperature: Some(0.2),
            ..Default::default()
        }
    }

    pub fn with_system<S: Into<String>>(mut self, system: S) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn with_schema(mut self, schema: serde_json::Value) -> Self {
        self.schema = Some(schema);
        self
    }

    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }
}

#[derive(Debug, Clone)]
pub struct ObjectGenerationResponse {
    pub object: serde_json::Value,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct EmbeddingParams {
    pub text: String,
}

impl EmbeddingParams {
    pub fn new<S: Into<String>>(text: S) -> Self {
        Self { text: text.into() }
    }
}

#[derive(Debug, Clone)]
pub struct EmbeddingResponse {
    pub embedding: Vec<f64>,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub size: u64,
    pub modified_at: String,
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GenerateResponse {
    pub model: String,
    pub response: String,
    pub done: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct EmbeddingsRequest {
    pub model: String,
    pub prompt: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct EmbeddingsResponse {
    pub embedding: Vec<f64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TagsResponse {
    pub models: Vec<ModelInfo>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ShowRequest {
    pub model: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PullRequest {
    pub model: String,
    pub stream: bool,
}
