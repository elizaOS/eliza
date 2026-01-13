//! Model implementations for SWE-agent
//!
//! This module contains various model implementations for interacting with LLMs.

use crate::exceptions::{Result, SWEAgentError};
use crate::types::{History, ModelOutput, ModelStats, RetryConfig, Role, ToolCall};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Global statistics tracking across all model instances
#[derive(Debug, Default)]
pub struct GlobalStats {
    pub total_cost: AtomicU64, // Stored as micro-dollars for precision
    pub last_query_timestamp: AtomicU64,
}

impl GlobalStats {
    pub fn add_cost(&self, cost: f64) {
        let micro_cost = (cost * 1_000_000.0) as u64;
        self.total_cost.fetch_add(micro_cost, Ordering::SeqCst);
    }

    pub fn get_total_cost(&self) -> f64 {
        self.total_cost.load(Ordering::SeqCst) as f64 / 1_000_000.0
    }

    pub fn update_timestamp(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.last_query_timestamp.store(now, Ordering::SeqCst);
    }
}

/// Instance-specific statistics
#[derive(Debug, Default, Clone)]
pub struct InstanceStats {
    pub instance_cost: f64,
    pub tokens_sent: u64,
    pub tokens_received: u64,
    pub api_calls: u64,
}

impl InstanceStats {
    pub fn add(&self, other: &InstanceStats) -> InstanceStats {
        InstanceStats {
            instance_cost: self.instance_cost + other.instance_cost,
            tokens_sent: self.tokens_sent + other.tokens_sent,
            tokens_received: self.tokens_received + other.tokens_received,
            api_calls: self.api_calls + other.api_calls,
        }
    }

    pub fn to_model_stats(&self) -> ModelStats {
        ModelStats {
            instance_cost: self.instance_cost,
            tokens_sent: self.tokens_sent,
            tokens_received: self.tokens_received,
            api_calls: self.api_calls,
        }
    }
}

/// Abstract trait for all models
#[async_trait]
pub trait Model: Send + Sync {
    /// Query the model with conversation history
    async fn query(&self, history: &History) -> Result<ModelOutput>;

    /// Query with specific temperature and number of completions
    async fn query_with_params(
        &self,
        history: &History,
        _temperature: Option<f64>,
        _n: Option<usize>,
    ) -> Result<Vec<ModelOutput>> {
        let output = self.query(history).await?;
        Ok(vec![output])
    }

    /// Reset instance statistics
    fn reset_stats(&self);

    /// Get current instance statistics
    fn get_stats(&self) -> InstanceStats;

    /// Get per-instance cost limit
    fn instance_cost_limit(&self) -> f64;
}

/// Generic API model configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenericApiModelConfig {
    pub name: String,
    #[serde(default = "default_per_instance_cost_limit")]
    pub per_instance_cost_limit: f64,
    #[serde(default)]
    pub total_cost_limit: f64,
    #[serde(default)]
    pub per_instance_call_limit: u64,
    #[serde(default)]
    pub temperature: f64,
    #[serde(default = "default_top_p")]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub api_base: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub stop: Vec<String>,
    #[serde(default)]
    pub completion_kwargs: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub convert_system_to_user: bool,
    #[serde(default)]
    pub retry: RetryConfig,
    #[serde(default)]
    pub delay: f64,
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
}

fn default_per_instance_cost_limit() -> f64 {
    3.0
}

fn default_top_p() -> Option<f64> {
    Some(1.0)
}

impl Default for GenericApiModelConfig {
    fn default() -> Self {
        Self {
            name: "gpt-4".to_string(),
            per_instance_cost_limit: default_per_instance_cost_limit(),
            total_cost_limit: 0.0,
            per_instance_call_limit: 0,
            temperature: 0.0,
            top_p: default_top_p(),
            api_base: None,
            api_key: None,
            stop: Vec::new(),
            completion_kwargs: HashMap::new(),
            convert_system_to_user: false,
            retry: RetryConfig::default(),
            delay: 0.0,
            max_input_tokens: None,
            max_output_tokens: None,
        }
    }
}

/// LiteLLM-compatible model for API-based LLMs
pub struct LiteLLMModel {
    config: GenericApiModelConfig,
    stats: Arc<Mutex<InstanceStats>>,
    global_stats: Arc<GlobalStats>,
    api_keys: Vec<String>,
    current_key_index: Arc<AtomicU64>,
    client: reqwest::Client,
}

impl LiteLLMModel {
    pub fn new(config: GenericApiModelConfig, global_stats: Arc<GlobalStats>) -> Self {
        let api_keys = Self::get_api_keys(&config);
        Self {
            config,
            stats: Arc::new(Mutex::new(InstanceStats::default())),
            global_stats,
            api_keys,
            current_key_index: Arc::new(AtomicU64::new(0)),
            client: reqwest::Client::new(),
        }
    }

    fn get_api_keys(config: &GenericApiModelConfig) -> Vec<String> {
        if let Some(ref key) = config.api_key {
            if let Some(stripped) = key.strip_prefix('$') {
                // Environment variable
                if let Ok(env_key) = std::env::var(stripped) {
                    return env_key.split(":::").map(String::from).collect();
                }
            } else {
                return key.split(":::").map(String::from).collect();
            }
        }

        // Try environment variable based on model name
        let env_name = format!("{}_API_KEY", config.name.to_uppercase().replace('-', "_"));
        if let Ok(key) = std::env::var(&env_name) {
            return key.split(":::").map(String::from).collect();
        }

        Vec::new()
    }

    fn choose_api_key(&self) -> Option<String> {
        if self.api_keys.is_empty() {
            return None;
        }

        let idx = self.current_key_index.fetch_add(1, Ordering::SeqCst) as usize;
        Some(self.api_keys[idx % self.api_keys.len()].clone())
    }

    fn history_to_messages(&self, history: &History) -> Vec<serde_json::Value> {
        history
            .iter()
            .map(|item| {
                let role = match item.role {
                    Role::System => {
                        if self.config.convert_system_to_user {
                            "user"
                        } else {
                            "system"
                        }
                    }
                    Role::User => "user",
                    Role::Assistant => "assistant",
                    Role::Tool => "tool",
                };

                let mut msg = serde_json::json!({
                    "role": role,
                    "content": item.content.as_str(),
                });

                if let Some(ref tool_calls) = item.tool_calls {
                    msg["tool_calls"] = serde_json::to_value(tool_calls).unwrap_or_default();
                }

                if let Some(ref ids) = item.tool_call_ids {
                    if !ids.is_empty() {
                        msg["tool_call_id"] = serde_json::Value::String(ids[0].clone());
                    }
                }

                msg
            })
            .collect()
    }

    fn calculate_cost(&self, input_tokens: u64, output_tokens: u64) -> f64 {
        // Simplified pricing - in production, use actual model pricing
        let (input_price, output_price) = match self.config.name.as_str() {
            name if name.contains("gpt-4") => (0.03 / 1000.0, 0.06 / 1000.0),
            name if name.contains("gpt-3.5") => (0.0005 / 1000.0, 0.0015 / 1000.0),
            name if name.contains("claude-3-opus") => (0.015 / 1000.0, 0.075 / 1000.0),
            name if name.contains("claude-3-sonnet") => (0.003 / 1000.0, 0.015 / 1000.0),
            name if name.contains("claude-3-haiku") => (0.00025 / 1000.0, 0.00125 / 1000.0),
            _ => (0.001 / 1000.0, 0.002 / 1000.0),
        };

        input_tokens as f64 * input_price + output_tokens as f64 * output_price
    }

    async fn check_cost_limits(&self) -> Result<()> {
        let stats = self.stats.lock().await;

        if self.config.per_instance_cost_limit > 0.0
            && stats.instance_cost >= self.config.per_instance_cost_limit
        {
            return Err(SWEAgentError::InstanceCostLimitExceeded(format!(
                "Instance cost {} exceeds limit {}",
                stats.instance_cost, self.config.per_instance_cost_limit
            )));
        }

        if self.config.total_cost_limit > 0.0
            && self.global_stats.get_total_cost() >= self.config.total_cost_limit
        {
            return Err(SWEAgentError::TotalCostLimitExceeded(format!(
                "Total cost {} exceeds limit {}",
                self.global_stats.get_total_cost(),
                self.config.total_cost_limit
            )));
        }

        if self.config.per_instance_call_limit > 0
            && stats.api_calls >= self.config.per_instance_call_limit
        {
            return Err(SWEAgentError::InstanceCallLimitExceeded(format!(
                "API calls {} exceeds limit {}",
                stats.api_calls, self.config.per_instance_call_limit
            )));
        }

        Ok(())
    }
}

#[async_trait]
impl Model for LiteLLMModel {
    async fn query(&self, history: &History) -> Result<ModelOutput> {
        self.check_cost_limits().await?;

        let api_key = self.choose_api_key();
        let messages = self.history_to_messages(history);

        // Determine API endpoint based on model name
        let is_anthropic = self.config.name.contains("claude");
        let _is_openai = self.config.name.contains("gpt");

        let (url, headers) = if is_anthropic {
            let url = self
                .config
                .api_base
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com/v1/messages".to_string());
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("Content-Type", "application/json".parse().unwrap());
            headers.insert("anthropic-version", "2023-06-01".parse().unwrap());
            if let Some(ref key) = api_key {
                headers.insert("x-api-key", key.parse().unwrap());
            }
            (url, headers)
        } else {
            let url = self
                .config
                .api_base
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("Content-Type", "application/json".parse().unwrap());
            if let Some(ref key) = api_key {
                headers.insert("Authorization", format!("Bearer {}", key).parse().unwrap());
            }
            (url, headers)
        };

        let mut request_body = serde_json::json!({
            "model": self.config.name,
            "messages": messages,
            "temperature": self.config.temperature,
        });

        if let Some(top_p) = self.config.top_p {
            request_body["top_p"] = serde_json::Value::from(top_p);
        }

        if !self.config.stop.is_empty() {
            request_body["stop"] = serde_json::to_value(&self.config.stop)?;
        }

        if let Some(max_tokens) = self.config.max_output_tokens {
            request_body["max_tokens"] = serde_json::Value::from(max_tokens);
        }

        // Handle Anthropic-specific format
        if is_anthropic {
            let system_msg = messages.iter().find(|m| m["role"] == "system");
            if let Some(sys) = system_msg {
                request_body["system"] = sys["content"].clone();
                let non_system: Vec<_> = messages
                    .iter()
                    .filter(|m| m["role"] != "system")
                    .cloned()
                    .collect();
                request_body["messages"] = serde_json::to_value(non_system)?;
            }
        }

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&request_body)
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await.unwrap_or_default();

        if !status.is_success() {
            // Check for specific error types
            if response_text.contains("content_policy") || response_text.contains("safety") {
                return Err(SWEAgentError::ContentPolicyViolation(response_text));
            }
            return Err(SWEAgentError::ApiError(format!(
                "API request failed with status {}: {}",
                status, response_text
            )));
        }

        // Parse response - handle both OpenAI and Anthropic formats
        let json_response: serde_json::Value = serde_json::from_str(&response_text)
            .map_err(|e| SWEAgentError::ApiError(format!("Failed to parse response: {}", e)))?;

        let (message, tool_calls, input_tokens, output_tokens) = if is_anthropic {
            // Anthropic format: { "content": [{"type": "text", "text": "..."}], "usage": {...} }
            let content = json_response
                .get("content")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                item.get("text").and_then(|t| t.as_str()).map(String::from)
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();

            // Extract tool use blocks from Anthropic response
            let tools: Option<Vec<ToolCall>> = json_response
                .get("content")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                let id = item
                                    .get("id")
                                    .and_then(|i| i.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let name = item
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let args = item
                                    .get("input")
                                    .map(|i| serde_json::to_string(i).unwrap_or_default())
                                    .unwrap_or_default();
                                Some(ToolCall {
                                    id,
                                    call_type: "function".to_string(),
                                    function: crate::types::ToolCallFunction {
                                        name,
                                        arguments: args,
                                    },
                                })
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .filter(|v: &Vec<ToolCall>| !v.is_empty());

            let usage = json_response.get("usage");
            let input = usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            let output = usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);

            (content, tools, input, output)
        } else {
            // OpenAI format: { "choices": [{"message": {"content": "..."}}], "usage": {...} }
            let message_content = json_response
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|msg| msg.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();

            // Extract tool calls from OpenAI response
            let tools: Option<Vec<ToolCall>> = json_response
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|msg| msg.get("tool_calls"))
                .and_then(|tc| tc.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            let id = item
                                .get("id")
                                .and_then(|i| i.as_str())
                                .unwrap_or("")
                                .to_string();
                            let func = item.get("function")?;
                            let name = func
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args = func
                                .get("arguments")
                                .and_then(|a| a.as_str())
                                .unwrap_or("")
                                .to_string();
                            Some(ToolCall {
                                id,
                                call_type: "function".to_string(),
                                function: crate::types::ToolCallFunction {
                                    name,
                                    arguments: args,
                                },
                            })
                        })
                        .collect()
                })
                .filter(|v: &Vec<ToolCall>| !v.is_empty());

            let usage = json_response.get("usage");
            let input = usage
                .and_then(|u| u.get("prompt_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            let output = usage
                .and_then(|u| u.get("completion_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);

            (message_content, tools, input, output)
        };

        // Update stats
        let cost = self.calculate_cost(input_tokens, output_tokens);

        {
            let mut stats = self.stats.lock().await;
            stats.tokens_sent += input_tokens;
            stats.tokens_received += output_tokens;
            stats.instance_cost += cost;
            stats.api_calls += 1;
        }

        self.global_stats.add_cost(cost);
        self.global_stats.update_timestamp();

        Ok(ModelOutput {
            message,
            tool_calls,
            thinking_blocks: None,
        })
    }

    fn reset_stats(&self) {
        if let Ok(mut stats) = self.stats.try_lock() {
            *stats = InstanceStats::default();
        }
    }

    fn get_stats(&self) -> InstanceStats {
        self.stats.try_lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn instance_cost_limit(&self) -> f64 {
        self.config.per_instance_cost_limit
    }
}

/// Human model for interactive input
pub struct HumanModel {
    stats: Arc<Mutex<InstanceStats>>,
    cost_per_call: f64,
}

impl HumanModel {
    pub fn new(cost_per_call: f64) -> Self {
        Self {
            stats: Arc::new(Mutex::new(InstanceStats::default())),
            cost_per_call,
        }
    }
}

#[async_trait]
impl Model for HumanModel {
    async fn query(&self, _history: &History) -> Result<ModelOutput> {
        use std::io::{self, BufRead, Write};

        print!("> ");
        io::stdout().flush()?;

        let stdin = io::stdin();
        let line = stdin.lock().lines().next();

        let input = match line {
            Some(Ok(s)) => s,
            Some(Err(e)) => return Err(SWEAgentError::IoError(e.to_string())),
            None => return Err(SWEAgentError::EOF),
        };

        {
            let mut stats = self.stats.lock().await;
            stats.api_calls += 1;
            stats.instance_cost += self.cost_per_call;
        }

        Ok(ModelOutput {
            message: input,
            tool_calls: None,
            thinking_blocks: None,
        })
    }

    fn reset_stats(&self) {
        if let Ok(mut stats) = self.stats.try_lock() {
            *stats = InstanceStats::default();
        }
    }

    fn get_stats(&self) -> InstanceStats {
        self.stats.try_lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn instance_cost_limit(&self) -> f64 {
        0.0
    }
}

/// Instant empty submit model for testing
pub struct InstantEmptySubmitModel {
    stats: Arc<Mutex<InstanceStats>>,
    action_idx: Arc<AtomicU64>,
}

impl InstantEmptySubmitModel {
    pub fn new() -> Self {
        Self {
            stats: Arc::new(Mutex::new(InstanceStats::default())),
            action_idx: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl Default for InstantEmptySubmitModel {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Model for InstantEmptySubmitModel {
    async fn query(&self, _history: &History) -> Result<ModelOutput> {
        let idx = self.action_idx.fetch_add(1, Ordering::SeqCst);

        let message = if idx == 0 {
            "DISCUSSION\nLet's reproduce the bug by creating a `reproduce.py` file.\n\n```\ntouch reproduce.py\n```\n"
        } else {
            self.action_idx.store(0, Ordering::SeqCst);
            "DISCUSSION\nThe task should be resolved, so let's submit the patch.\n\n```\nsubmit\n```\n"
        };

        {
            let mut stats = self.stats.lock().await;
            stats.api_calls += 1;
        }

        Ok(ModelOutput {
            message: message.to_string(),
            tool_calls: None,
            thinking_blocks: None,
        })
    }

    fn reset_stats(&self) {
        if let Ok(mut stats) = self.stats.try_lock() {
            *stats = InstanceStats::default();
        }
        self.action_idx.store(0, Ordering::SeqCst);
    }

    fn get_stats(&self) -> InstanceStats {
        self.stats.try_lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn instance_cost_limit(&self) -> f64 {
        0.0
    }
}

/// Replay model for replaying trajectories
pub struct ReplayModel {
    stats: Arc<Mutex<InstanceStats>>,
    replays: Vec<Vec<String>>,
    replay_idx: Arc<AtomicU64>,
    action_idx: Arc<AtomicU64>,
    submit_command: String,
}

impl ReplayModel {
    pub fn new(replay_path: &str, submit_command: &str) -> Result<Self> {
        let content = std::fs::read_to_string(replay_path)?;
        let replays: Vec<Vec<String>> = content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| {
                serde_json::from_str::<HashMap<String, Vec<String>>>(l)
                    .ok()
                    .and_then(|m| m.into_values().next())
            })
            .collect();

        Ok(Self {
            stats: Arc::new(Mutex::new(InstanceStats::default())),
            replays,
            replay_idx: Arc::new(AtomicU64::new(0)),
            action_idx: Arc::new(AtomicU64::new(0)),
            submit_command: submit_command.to_string(),
        })
    }
}

#[async_trait]
impl Model for ReplayModel {
    async fn query(&self, _history: &History) -> Result<ModelOutput> {
        let replay_idx = self.replay_idx.load(Ordering::SeqCst) as usize;
        let action_idx = self.action_idx.fetch_add(1, Ordering::SeqCst) as usize;

        let action = if replay_idx >= self.replays.len() {
            format!("```\n{}\n```", self.submit_command)
        } else if action_idx >= self.replays[replay_idx].len() {
            tracing::error!("Reached end of replay trajectory without submitting");
            self.replay_idx.fetch_add(1, Ordering::SeqCst);
            self.action_idx.store(0, Ordering::SeqCst);
            format!("```\n{}\n```", self.submit_command)
        } else {
            let action = &self.replays[replay_idx][action_idx];
            if action == "submit" || action.contains(&self.submit_command) {
                self.replay_idx.fetch_add(1, Ordering::SeqCst);
                self.action_idx.store(0, Ordering::SeqCst);
            }
            action.clone()
        };

        {
            let mut stats = self.stats.lock().await;
            stats.api_calls += 1;
        }

        Ok(ModelOutput {
            message: action,
            tool_calls: None,
            thinking_blocks: None,
        })
    }

    fn reset_stats(&self) {
        if let Ok(mut stats) = self.stats.try_lock() {
            *stats = InstanceStats::default();
        }
    }

    fn get_stats(&self) -> InstanceStats {
        self.stats.try_lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn instance_cost_limit(&self) -> f64 {
        0.0
    }
}

/// Model configuration enum
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "name")]
pub enum ModelConfig {
    #[serde(rename = "human")]
    Human { cost_per_call: Option<f64> },
    #[serde(rename = "instant_empty_submit")]
    InstantEmptySubmit,
    #[serde(rename = "replay")]
    Replay { replay_path: String },
    #[serde(untagged)]
    Generic(Box<GenericApiModelConfig>),
}

impl Default for ModelConfig {
    fn default() -> Self {
        ModelConfig::Generic(Box::default())
    }
}

/// Create a model from configuration
pub fn get_model(config: ModelConfig, global_stats: Arc<GlobalStats>) -> Result<Box<dyn Model>> {
    match config {
        ModelConfig::Human { cost_per_call } => {
            Ok(Box::new(HumanModel::new(cost_per_call.unwrap_or(0.0))))
        }
        ModelConfig::InstantEmptySubmit => Ok(Box::new(InstantEmptySubmitModel::new())),
        ModelConfig::Replay { replay_path } => {
            Ok(Box::new(ReplayModel::new(&replay_path, "submit")?))
        }
        ModelConfig::Generic(config) => Ok(Box::new(LiteLLMModel::new(*config, global_stats))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_instant_empty_submit_model() {
        let model = InstantEmptySubmitModel::new();
        let history = vec![];

        let output1 = model.query(&history).await.unwrap();
        assert!(output1.message.contains("reproduce.py"));

        let output2 = model.query(&history).await.unwrap();
        assert!(output2.message.contains("submit"));
    }

    #[test]
    fn test_instance_stats_add() {
        let a = InstanceStats {
            instance_cost: 1.0,
            tokens_sent: 100,
            tokens_received: 50,
            api_calls: 1,
        };
        let b = InstanceStats {
            instance_cost: 2.0,
            tokens_sent: 200,
            tokens_received: 100,
            api_calls: 2,
        };
        let c = a.add(&b);

        assert_eq!(c.instance_cost, 3.0);
        assert_eq!(c.tokens_sent, 300);
        assert_eq!(c.api_calls, 3);
    }
}
