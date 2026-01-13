use serde::{Deserialize, Serialize};
/// JSON-compatible value type used throughout the trajectory format.
pub type JsonValue = serde_json::Value;
use std::collections::HashMap;

/// LLM call purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum LLMPurpose {
    Action,
    Reasoning,
    Evaluation,
    Response,
    #[default]
    Other,
}

/// Conversation message used inside an LLM call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LLMMessage {
    pub role: String,
    pub content: String,
}

/// Represents a single LLM call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMCall {
    pub call_id: String,
    pub timestamp: i64,
    pub model: String,
    pub model_version: Option<String>,
    pub system_prompt: String,
    pub user_prompt: String,
    pub messages: Option<Vec<LLMMessage>>,
    pub response: String,
    pub reasoning: Option<String>,
    pub temperature: f64,
    pub max_tokens: u32,
    pub top_p: Option<f64>,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub latency_ms: Option<u32>,
    pub purpose: LLMPurpose,
    pub action_type: Option<String>,
}

/// Provider access record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccess {
    pub provider_id: String,
    pub provider_name: String,
    pub timestamp: i64,
    pub query: Option<HashMap<String, JsonValue>>,
    pub data: HashMap<String, JsonValue>,
    pub purpose: String,
}

/// Action attempt record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionAttempt {
    pub attempt_id: String,
    pub timestamp: i64,
    pub action_type: String,
    pub action_name: String,
    pub parameters: HashMap<String, JsonValue>,
    pub reasoning: Option<String>,
    pub llm_call_id: Option<String>,
    pub success: bool,
    pub result: Option<HashMap<String, JsonValue>>,
    pub error: Option<String>,
    pub immediate_reward: Option<f64>,
}

/// Environment state snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentState {
    pub timestamp: i64,
    pub agent_balance: f64,
    pub agent_points: f64,
    pub agent_pnl: f64,
    pub open_positions: u32,
    pub active_markets: Option<u32>,
    pub portfolio_value: Option<f64>,
    pub unread_messages: Option<u32>,
    pub recent_engagement: Option<u32>,
    pub custom: Option<HashMap<String, JsonValue>>,
}

/// Trajectory step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryStep {
    pub step_id: String,
    pub step_number: u32,
    pub timestamp: i64,
    pub environment_state: EnvironmentState,
    #[serde(default)]
    pub observation: HashMap<String, JsonValue>,
    #[serde(default)]
    pub llm_calls: Vec<LLMCall>,
    #[serde(default)]
    pub provider_accesses: Vec<ProviderAccess>,
    pub reasoning: Option<String>,
    pub action: ActionAttempt,
    pub reward: f64,
    pub done: bool,
    pub metadata: Option<HashMap<String, JsonValue>>,
}

/// Reward component breakdown (free-form).
pub type RewardBreakdown = HashMap<String, f64>;

/// Reward components.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RewardComponents {
    pub environment_reward: f64,
    pub ai_judge_reward: Option<f64>,
    pub components: Option<RewardBreakdown>,
    pub judge_model: Option<String>,
    pub judge_reasoning: Option<String>,
    pub judge_timestamp: Option<i64>,
}

/// Trajectory final status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum FinalStatus {
    #[default]
    Completed,
    Terminated,
    Error,
    Timeout,
}

/// Trajectory metrics (includes an `extra` map for arbitrary metrics).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryMetrics {
    pub episode_length: u32,
    pub final_status: FinalStatus,
    pub final_balance: Option<f64>,
    pub final_pnl: Option<f64>,
    pub trades_executed: Option<u32>,
    pub posts_created: Option<u32>,
    pub messages_handled: Option<u32>,
    pub success_rate: Option<f64>,
    pub error_count: Option<u32>,
    #[serde(flatten)]
    pub extra: HashMap<String, JsonValue>,
}

/// Trajectory record.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Trajectory {
    pub trajectory_id: String,
    pub agent_id: String,
    pub start_time: i64,
    pub end_time: i64,
    pub duration_ms: i64,
    pub episode_id: Option<String>,
    pub scenario_id: Option<String>,
    pub batch_id: Option<String>,
    pub group_index: Option<u32>,
    #[serde(default)]
    pub steps: Vec<TrajectoryStep>,
    pub total_reward: f64,
    pub reward_components: RewardComponents,
    pub metrics: TrajectoryMetrics,
    #[serde(default)]
    pub metadata: HashMap<String, JsonValue>,
}

/// Chat message for ART format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub name: Option<String>,
}

/// ART trajectory format (messages + reward + metadata).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ARTTrajectory {
    pub messages: Vec<ChatMessage>,
    pub reward: f64,
    pub metadata: HashMap<String, JsonValue>,
    pub metrics: Option<HashMap<String, f64>>,
}

/// Trajectory group (for GRPO).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryGroup {
    pub group_id: String,
    pub scenario_id: String,
    pub trajectories: Vec<Trajectory>,
    pub shared_prefix: Option<Vec<ChatMessage>>,
    pub rankings: Option<Vec<i32>>,
    pub normalized_rewards: Option<Vec<f64>>,
    pub ruler_scores: Option<Vec<f64>>,
    pub created_at: i64,
    pub model_version: Option<String>,
}
