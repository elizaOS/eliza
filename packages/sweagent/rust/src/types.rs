//! Core type definitions for SWE-agent
//!
//! This module contains all shared types used throughout the SWE-agent implementation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Role in a conversation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

/// Type of message in history
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    System,
    #[default]
    Observation,
    Action,
    Thought,
    Demonstration,
    User,
    Assistant,
}

/// A thinking block from model output (for Claude-style extended thinking)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<f64>,
}

/// Tool call function definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

/// A tool call from model output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ToolCallFunction,
}

/// Content can be either a string or structured content
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Structured(Vec<ContentPart>),
}

impl Default for Content {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

impl Content {
    pub fn as_str(&self) -> String {
        match self {
            Content::Text(s) => s.clone(),
            Content::Structured(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

/// Part of structured content
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    Image { image_url: ImageUrl },
}

/// Image URL reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A single item in the conversation history
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistoryItem {
    pub role: Role,
    pub content: Content,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_type: Option<MessageType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_demo: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_blocks: Option<Vec<ThinkingBlock>>,
}

impl HistoryItem {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: Content::Text(content.into()),
            message_type: Some(MessageType::System),
            ..Default::default()
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: Content::Text(content.into()),
            message_type: Some(MessageType::User),
            ..Default::default()
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: Content::Text(content.into()),
            message_type: Some(MessageType::Assistant),
            ..Default::default()
        }
    }

    pub fn observation(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: Content::Text(content.into()),
            message_type: Some(MessageType::Observation),
            ..Default::default()
        }
    }

    pub fn action(thought: impl Into<String>, action: impl Into<String>) -> Self {
        let thought_str = thought.into();
        let action_str = action.into();
        Self {
            role: Role::Assistant,
            content: Content::Text(format!("{}\n```\n{}\n```", thought_str, action_str)),
            message_type: Some(MessageType::Action),
            thought: Some(thought_str),
            action: Some(action_str),
            ..Default::default()
        }
    }
}

/// Conversation history
pub type History = Vec<HistoryItem>;

/// Environment state at a point in time
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnvironmentState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Query message for tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryMessage {
    pub role: Role,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_type: Option<MessageType>,
}

/// Output from a single agent step
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StepOutput {
    pub done: bool,
    pub thought: String,
    pub action: String,
    pub observation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<String>,
    pub execution_time: f64,
    pub state: EnvironmentState,
    pub query: Vec<QueryMessage>,
    #[serde(default)]
    pub extra_info: HashMap<String, serde_json::Value>,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_blocks: Option<Vec<ThinkingBlock>>,
}

impl StepOutput {
    pub fn to_template_format_dict(&self) -> HashMap<String, String> {
        let mut dict = HashMap::new();
        dict.insert("thought".to_string(), self.thought.clone());
        dict.insert("action".to_string(), self.action.clone());
        dict.insert("observation".to_string(), self.observation.clone());
        if let Some(ref status) = self.exit_status {
            dict.insert("exit_status".to_string(), status.clone());
        }
        dict
    }
}

/// A single step in a trajectory
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrajectoryStep {
    pub action: String,
    pub observation: String,
    pub response: String,
    pub thought: String,
    pub execution_time: f64,
    pub state: EnvironmentState,
    pub query: Vec<QueryMessage>,
    #[serde(default)]
    pub extra_info: HashMap<String, serde_json::Value>,
}

impl From<&StepOutput> for TrajectoryStep {
    fn from(step: &StepOutput) -> Self {
        Self {
            action: step.action.clone(),
            observation: step.observation.clone(),
            response: step.output.clone(),
            thought: step.thought.clone(),
            execution_time: step.execution_time,
            state: step.state.clone(),
            query: step.query.clone(),
            extra_info: step.extra_info.clone(),
        }
    }
}

/// Full trajectory of an agent run
pub type Trajectory = Vec<TrajectoryStep>;

/// Model statistics for tracking costs and usage
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelStats {
    pub instance_cost: f64,
    pub tokens_sent: u64,
    pub tokens_received: u64,
    pub api_calls: u64,
}

impl ModelStats {
    pub fn add(&self, other: &ModelStats) -> ModelStats {
        ModelStats {
            instance_cost: self.instance_cost + other.instance_cost,
            tokens_sent: self.tokens_sent + other.tokens_sent,
            tokens_received: self.tokens_received + other.tokens_received,
            api_calls: self.api_calls + other.api_calls,
        }
    }
}

/// Agent run information
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swe_agent_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_stats: Option<ModelStats>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Result of an agent run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunResult {
    pub info: AgentInfo,
    pub trajectory: Trajectory,
}

/// Output from a model query
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelOutput {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_blocks: Option<Vec<ThinkingBlock>>,
}

/// API response from LLM providers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<ApiChoice>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<ApiUsage>,
}

/// A single choice in API response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiChoice {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<ApiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Message in API response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// Usage statistics in API response
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

/// Batch instance for running multiple problems
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchInstance {
    pub instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem_statement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Simple batch instance format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimpleBatchInstance {
    pub id: String,
    pub problem_statement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_url: Option<String>,
}

/// Retry configuration for API calls
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    #[serde(default = "default_retries")]
    pub retries: u32,
    #[serde(default = "default_min_wait")]
    pub min_wait: u64,
    #[serde(default = "default_max_wait")]
    pub max_wait: u64,
}

fn default_retries() -> u32 {
    20
}

fn default_min_wait() -> u64 {
    10
}

fn default_max_wait() -> u64 {
    120
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            retries: default_retries(),
            min_wait: default_min_wait(),
            max_wait: default_max_wait(),
        }
    }
}

/// Template configuration for agent messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateConfig {
    #[serde(default)]
    pub system_template: String,
    #[serde(default)]
    pub instance_template: String,
    #[serde(default = "default_next_step_template")]
    pub next_step_template: String,
    #[serde(default = "default_next_step_truncated_template")]
    pub next_step_truncated_observation_template: String,
    #[serde(default = "default_max_observation_length")]
    pub max_observation_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_step_no_output_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demonstration_template: Option<String>,
    #[serde(default)]
    pub demonstrations: Vec<String>,
    #[serde(default)]
    pub put_demos_in_history: bool,
    #[serde(default)]
    pub disable_image_processing: bool,
    #[serde(default = "default_shell_check_error_template")]
    pub shell_check_error_template: String,
    #[serde(default = "default_command_cancelled_template")]
    pub command_cancelled_timeout_template: String,
}

fn default_next_step_template() -> String {
    "Observation: {{observation}}".to_string()
}

fn default_next_step_truncated_template() -> String {
    "Observation: {{observation}}<response clipped>\n<NOTE>Observations should not exceed {{max_observation_length}} characters. {{elided_chars}} characters were elided.</NOTE>".to_string()
}

fn default_max_observation_length() -> usize {
    100000
}

fn default_shell_check_error_template() -> String {
    "Your command contains syntax errors. Please fix them and try again.\nError: {{error_message}}\nHint: {{hint}}".to_string()
}

fn default_command_cancelled_template() -> String {
    "Command cancelled after {{timeout}} seconds. The command was: {{command}}".to_string()
}

impl Default for TemplateConfig {
    fn default() -> Self {
        Self {
            system_template: String::new(),
            instance_template: String::new(),
            next_step_template: default_next_step_template(),
            next_step_truncated_observation_template: default_next_step_truncated_template(),
            max_observation_length: default_max_observation_length(),
            next_step_no_output_template: None,
            strategy_template: None,
            demonstration_template: None,
            demonstrations: Vec::new(),
            put_demos_in_history: false,
            disable_image_processing: false,
            shell_check_error_template: default_shell_check_error_template(),
            command_cancelled_timeout_template: default_command_cancelled_template(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history_item_system() {
        let item = HistoryItem::system("You are a helpful assistant.");
        assert_eq!(item.role, Role::System);
        assert_eq!(item.content.as_str(), "You are a helpful assistant.");
    }

    #[test]
    fn test_history_item_action() {
        let item = HistoryItem::action("I will run a command", "ls -la");
        assert_eq!(item.role, Role::Assistant);
        assert_eq!(item.thought, Some("I will run a command".to_string()));
        assert_eq!(item.action, Some("ls -la".to_string()));
    }

    #[test]
    fn test_step_output_to_template_dict() {
        let step = StepOutput {
            thought: "thinking".to_string(),
            action: "doing".to_string(),
            observation: "seeing".to_string(),
            exit_status: Some("done".to_string()),
            ..Default::default()
        };
        let dict = step.to_template_format_dict();
        assert_eq!(dict.get("thought"), Some(&"thinking".to_string()));
        assert_eq!(dict.get("action"), Some(&"doing".to_string()));
        assert_eq!(dict.get("observation"), Some(&"seeing".to_string()));
        assert_eq!(dict.get("exit_status"), Some(&"done".to_string()));
    }

    #[test]
    fn test_model_stats_add() {
        let a = ModelStats {
            instance_cost: 1.0,
            tokens_sent: 100,
            tokens_received: 50,
            api_calls: 1,
        };
        let b = ModelStats {
            instance_cost: 2.0,
            tokens_sent: 200,
            tokens_received: 100,
            api_calls: 2,
        };
        let c = a.add(&b);
        assert_eq!(c.instance_cost, 3.0);
        assert_eq!(c.tokens_sent, 300);
        assert_eq!(c.tokens_received, 150);
        assert_eq!(c.api_calls, 3);
    }
}
