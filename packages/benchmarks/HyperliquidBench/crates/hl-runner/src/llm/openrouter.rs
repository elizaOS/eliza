use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub struct OpenRouterConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: u32,
    pub title: String,
    pub user_agent: String,
}

pub struct OpenRouter {
    client: Client,
    config: OpenRouterConfig,
}

impl OpenRouter {
    pub fn new(config: OpenRouterConfig) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("failed to build reqwest client")?;
        Ok(Self { client, config })
    }

    pub async fn complete(&self, system: &str, user: &str) -> Result<Completion> {
        let body = json!({
            "model": self.config.model,
            "temperature": self.config.temperature,
            "top_p": self.config.top_p,
            "max_tokens": self.config.max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ]
        });

        let response = self
            .client
            .post(&self.config.endpoint)
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("X-Title", &self.config.title)
            .header("User-Agent", &self.config.user_agent)
            .json(&body)
            .send()
            .await
            .context("failed to send OpenRouter request")?;

        let status = response.status();
        let text = response
            .text()
            .await
            .context("failed to read OpenRouter response body")?;

        if status != StatusCode::OK {
            return Err(anyhow!(
                "OpenRouter returned status {} with body: {}",
                status,
                text
            ));
        }

        let parsed: CompletionResponse =
            serde_json::from_str(&text).context("failed to parse OpenRouter response JSON")?;

        let content = parsed
            .choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .ok_or_else(|| anyhow!("OpenRouter response missing content"))?;

        Ok(Completion {
            content,
            usage: parsed.usage,
        })
    }
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct Completion {
    pub content: String,
    pub usage: Option<Usage>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: Option<u32>,
    #[serde(default)]
    pub completion_tokens: Option<u32>,
    #[serde(default)]
    pub total_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct CompletionResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
}

pub fn hash_prompt(model: &str, system: &str, user: &str, temperature: f32, top_p: f32) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(model.as_bytes());
    hasher.update(temperature.to_le_bytes());
    hasher.update(top_p.to_le_bytes());
    hasher.update(system.as_bytes());
    hasher.update(user.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn cache_filename(hash: &str) -> String {
    format!("{}.json", hash)
}

pub fn build_cached_payload(content: &str, usage: Option<&Usage>) -> Value {
    json!({
        "content": content,
        "usage": usage
    })
}

pub fn parse_cached_payload(value: Value) -> Result<Completion> {
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("cached payload missing content"))?
        .to_string();
    let usage = value
        .get("usage")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("failed to parse cached usage")?;
    Ok(Completion { content, usage })
}
