//! Model definitions for the N8n Plugin.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Available Claude model identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum ClaudeModel {
    /// Claude 3.5 Sonnet - fast and efficient.
    #[serde(rename = "claude-3-5-sonnet-20241022")]
    Sonnet35,

    /// Claude 3 Opus - most capable.
    #[default]
    #[serde(rename = "claude-3-opus-20240229")]
    Opus3,
}

impl ClaudeModel {
    /// Get the model ID string.
    pub fn as_str(&self) -> &'static str {
        match self {
            ClaudeModel::Sonnet35 => "claude-3-5-sonnet-20241022",
            ClaudeModel::Opus3 => "claude-3-opus-20240229",
        }
    }

    /// Get a human-readable display name.
    pub fn display_name(&self) -> &'static str {
        match self {
            ClaudeModel::Sonnet35 => "Claude 3.5 Sonnet",
            ClaudeModel::Opus3 => "Claude 3 Opus",
        }
    }
}

impl fmt::Display for ClaudeModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl std::str::FromStr for ClaudeModel {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "claude-3-5-sonnet-20241022" => Ok(ClaudeModel::Sonnet35),
            "claude-3-opus-20240229" => Ok(ClaudeModel::Opus3),
            _ => Err(format!("Unknown model: {}", s)),
        }
    }
}

/// Status of a plugin creation job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Job is pending.
    #[default]
    Pending,
    /// Job is running.
    Running,
    /// Job completed successfully.
    Completed,
    /// Job failed.
    Failed,
    /// Job was cancelled.
    Cancelled,
}

impl JobStatus {
    /// Check if the job is still active (pending or running).
    pub fn is_active(&self) -> bool {
        matches!(self, JobStatus::Pending | JobStatus::Running)
    }

    /// Check if the job has reached a terminal state.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
        )
    }
}

impl fmt::Display for JobStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            JobStatus::Pending => "pending",
            JobStatus::Running => "running",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        };
        write!(f, "{}", s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_model_default() {
        assert_eq!(ClaudeModel::default(), ClaudeModel::Opus3);
    }

    #[test]
    fn test_claude_model_as_str() {
        assert_eq!(ClaudeModel::Sonnet35.as_str(), "claude-3-5-sonnet-20241022");
        assert_eq!(ClaudeModel::Opus3.as_str(), "claude-3-opus-20240229");
    }

    #[test]
    fn test_claude_model_from_str() {
        assert_eq!(
            "claude-3-5-sonnet-20241022".parse::<ClaudeModel>().unwrap(),
            ClaudeModel::Sonnet35
        );
        assert_eq!(
            "claude-3-opus-20240229".parse::<ClaudeModel>().unwrap(),
            ClaudeModel::Opus3
        );
    }

    #[test]
    fn test_job_status_is_active() {
        assert!(JobStatus::Pending.is_active());
        assert!(JobStatus::Running.is_active());
        assert!(!JobStatus::Completed.is_active());
        assert!(!JobStatus::Failed.is_active());
        assert!(!JobStatus::Cancelled.is_active());
    }

    #[test]
    fn test_job_status_is_terminal() {
        assert!(!JobStatus::Pending.is_terminal());
        assert!(!JobStatus::Running.is_terminal());
        assert!(JobStatus::Completed.is_terminal());
        assert!(JobStatus::Failed.is_terminal());
        assert!(JobStatus::Cancelled.is_terminal());
    }
}


