use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const DEFAULT_MAX_JOBS: usize = 100;
pub const DEFAULT_TIMEOUT_MS: u64 = 300_000;

/// How a job is scheduled to run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleType {
    /// One-time execution at a specific datetime.
    At { at: DateTime<Utc> },
    /// Recurring execution at a fixed interval.
    Every { interval: Duration },
    /// Cron-expression-based schedule (5-field standard: min hour dom month dow).
    Cron { expr: String },
}

/// What the job does when it fires.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PayloadType {
    /// Send a prompt to the agent.
    Prompt { text: String },
    /// Invoke a named action with optional parameters.
    Action {
        name: String,
        params: Option<HashMap<String, serde_json::Value>>,
    },
    /// Emit a custom event with optional data.
    Event {
        name: String,
        data: Option<HashMap<String, serde_json::Value>>,
    },
}

/// Runtime state of a cron job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Active,
    Paused,
    Completed,
    Failed,
}

impl Default for JobState {
    fn default() -> Self {
        Self::Active
    }
}

/// Complete definition of a cron job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobDefinition {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub schedule: ScheduleType,
    pub payload: PayloadType,
    pub state: JobState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_run: Option<DateTime<Utc>>,
    pub next_run: Option<DateTime<Utc>>,
    pub run_count: u64,
    pub max_runs: Option<u64>,
    pub room_id: Option<String>,
}

/// Partial updates for a job.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobUpdate {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub schedule: Option<ScheduleType>,
    pub payload: Option<PayloadType>,
    pub state: Option<JobState>,
    pub max_runs: Option<Option<u64>>,
    pub room_id: Option<Option<String>>,
}

/// Service-level configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronConfig {
    pub enabled: bool,
    pub max_jobs: usize,
    pub default_timeout_ms: u64,
}

impl Default for CronConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_jobs: DEFAULT_MAX_JOBS,
            default_timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}
