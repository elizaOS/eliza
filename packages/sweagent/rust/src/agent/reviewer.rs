//! Reviewer implementations for evaluating agent submissions
//!
//! Reviewers are used in retry loops to evaluate submissions and decide
//! whether to retry with different approaches.

use crate::exceptions::{Result, SWEAgentError};
use crate::types::{AgentInfo, Trajectory};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Result from a review
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerResult {
    pub score: f64,
    pub feedback: String,
    pub should_retry: bool,
    pub extra: HashMap<String, serde_json::Value>,
}

/// Data submitted for review
#[derive(Debug, Clone)]
pub struct ReviewSubmission {
    pub trajectory: Trajectory,
    pub info: AgentInfo,
    pub submission: Option<String>,
}

/// Trait for submission reviewers
#[async_trait]
pub trait Reviewer: Send + Sync {
    /// Review a submission
    async fn review(&self, submission: &ReviewSubmission) -> Result<ReviewerResult>;
}

/// Simple reviewer that always passes - baseline implementation
pub struct PassThroughReviewer;

#[async_trait]
impl Reviewer for PassThroughReviewer {
    async fn review(&self, _submission: &ReviewSubmission) -> Result<ReviewerResult> {
        Ok(ReviewerResult {
            score: 1.0,
            feedback: "Submission accepted (pass-through reviewer)".to_string(),
            should_retry: false,
            extra: HashMap::new(),
        })
    }
}

/// Reviewer that checks if a submission was actually provided
pub struct SubmissionPresenceReviewer {
    threshold: f64,
}

impl SubmissionPresenceReviewer {
    pub fn new(threshold: f64) -> Self {
        Self { threshold }
    }
}

impl Default for SubmissionPresenceReviewer {
    fn default() -> Self {
        Self::new(0.5)
    }
}

#[async_trait]
impl Reviewer for SubmissionPresenceReviewer {
    async fn review(&self, submission: &ReviewSubmission) -> Result<ReviewerResult> {
        let has_submission = submission
            .submission
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        let score = if has_submission { 1.0 } else { 0.0 };

        Ok(ReviewerResult {
            score,
            feedback: if has_submission {
                "Submission provided".to_string()
            } else {
                "No submission provided".to_string()
            },
            should_retry: score < self.threshold,
            extra: HashMap::new(),
        })
    }
}

/// Reviewer that checks submission is non-empty patch
pub struct PatchPresenceReviewer {
    min_lines: usize,
}

impl PatchPresenceReviewer {
    pub fn new(min_lines: usize) -> Self {
        Self { min_lines }
    }
}

impl Default for PatchPresenceReviewer {
    fn default() -> Self {
        Self::new(1)
    }
}

#[async_trait]
impl Reviewer for PatchPresenceReviewer {
    async fn review(&self, submission: &ReviewSubmission) -> Result<ReviewerResult> {
        let patch = submission.submission.as_deref().unwrap_or("");
        let has_diff_content = patch
            .lines()
            .any(|line| line.starts_with('+') || line.starts_with('-'));

        let line_count = patch.lines().count();
        let passes = has_diff_content && line_count >= self.min_lines;

        let score = if passes { 1.0 } else { 0.0 };

        Ok(ReviewerResult {
            score,
            feedback: if passes {
                format!("Valid patch with {} lines", line_count)
            } else if !has_diff_content {
                "Patch contains no diff content (+/- lines)".to_string()
            } else {
                format!(
                    "Patch too short ({} lines, need {})",
                    line_count, self.min_lines
                )
            },
            should_retry: !passes,
            extra: {
                let mut m = HashMap::new();
                m.insert("line_count".to_string(), serde_json::json!(line_count));
                m.insert(
                    "has_diff_content".to_string(),
                    serde_json::json!(has_diff_content),
                );
                m
            },
        })
    }
}

/// Chooser for selecting the best from multiple submissions
#[derive(Debug, Clone)]
pub struct ChooserOutput {
    pub best_index: usize,
    pub scores: Vec<f64>,
    pub reasoning: String,
}

/// Trait for choosers
#[async_trait]
pub trait Chooser: Send + Sync {
    /// Choose the best submission from a list
    async fn choose(&self, submissions: &[ReviewSubmission]) -> Result<ChooserOutput>;
}

/// Simple chooser that selects based on submission presence and length
pub struct SimpleChooser;

#[async_trait]
impl Chooser for SimpleChooser {
    async fn choose(&self, submissions: &[ReviewSubmission]) -> Result<ChooserOutput> {
        if submissions.is_empty() {
            return Err(SWEAgentError::ConfigurationError(
                "No submissions to choose from".to_string(),
            ));
        }

        // Score based on: has submission (0.5) + patch length normalized (0.5)
        let scores: Vec<f64> = submissions
            .iter()
            .map(|s| {
                let has_submission = s.submission.is_some();
                let patch_len = s.submission.as_ref().map(|p| p.len()).unwrap_or(0);
                let base_score = if has_submission { 0.5 } else { 0.0 };
                let len_score = (patch_len as f64 / 10000.0).min(0.5);
                base_score + len_score
            })
            .collect();

        let best_index = scores
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(i, _)| i)
            .unwrap_or(0);

        Ok(ChooserOutput {
            best_index,
            scores: scores.clone(),
            reasoning: format!(
                "Selected submission {} with score {:.2} (scores: {:?})",
                best_index, scores[best_index], scores
            ),
        })
    }
}

/// Abstract retry loop trait
#[async_trait]
pub trait RetryLoop: Send + Sync {
    /// Called when a submission is made
    fn on_submit(&mut self, submission: ReviewSubmission);

    /// Check if should retry
    fn should_retry(&self) -> bool;

    /// Get the best submission index
    fn get_best(&self) -> Option<usize>;
}

/// Simple retry loop with max attempts
pub struct MaxAttemptsRetryLoop {
    submissions: Vec<ReviewSubmission>,
    max_attempts: usize,
}

impl MaxAttemptsRetryLoop {
    pub fn new(max_attempts: usize) -> Self {
        Self {
            submissions: Vec::new(),
            max_attempts,
        }
    }
}

#[async_trait]
impl RetryLoop for MaxAttemptsRetryLoop {
    fn on_submit(&mut self, submission: ReviewSubmission) {
        self.submissions.push(submission);
    }

    fn should_retry(&self) -> bool {
        self.submissions.len() < self.max_attempts
    }

    fn get_best(&self) -> Option<usize> {
        if self.submissions.is_empty() {
            return None;
        }

        // Return the last submission with a patch, or the last one
        self.submissions
            .iter()
            .enumerate()
            .rev()
            .find(|(_, s)| s.submission.is_some())
            .map(|(i, _)| i)
            .or(Some(self.submissions.len() - 1))
    }
}

/// Retry loop with reviewer-based decisions
pub struct ReviewerRetryLoop {
    submissions: Vec<(ReviewSubmission, ReviewerResult)>,
    max_attempts: usize,
    reviewer: Box<dyn Reviewer>,
    score_threshold: f64,
}

impl ReviewerRetryLoop {
    pub fn new(max_attempts: usize, reviewer: Box<dyn Reviewer>, score_threshold: f64) -> Self {
        Self {
            submissions: Vec::new(),
            max_attempts,
            reviewer,
            score_threshold,
        }
    }

    /// Async review and store - must be called separately from on_submit
    pub async fn review_submission(
        &mut self,
        submission: ReviewSubmission,
    ) -> Result<ReviewerResult> {
        let result = self.reviewer.review(&submission).await?;
        self.submissions.push((submission, result.clone()));
        Ok(result)
    }
}

#[async_trait]
impl RetryLoop for ReviewerRetryLoop {
    fn on_submit(&mut self, submission: ReviewSubmission) {
        // Store with a placeholder review - actual review should use review_submission
        self.submissions.push((
            submission,
            ReviewerResult {
                score: 0.0,
                feedback: "Not reviewed".to_string(),
                should_retry: true,
                extra: HashMap::new(),
            },
        ));
    }

    fn should_retry(&self) -> bool {
        if self.submissions.is_empty() {
            return true;
        }

        // Stop if we've hit max attempts
        if self.submissions.len() >= self.max_attempts {
            return false;
        }

        // Stop if last submission passed threshold
        if let Some((_, result)) = self.submissions.last() {
            if result.score >= self.score_threshold {
                return false;
            }
        }

        true
    }

    fn get_best(&self) -> Option<usize> {
        self.submissions
            .iter()
            .enumerate()
            .max_by(|(_, (_, a)), (_, (_, b))| a.score.partial_cmp(&b.score).unwrap())
            .map(|(i, _)| i)
    }
}

fn default_threshold() -> f64 {
    0.5
}

fn default_min_lines() -> usize {
    1
}

/// Configuration for retry loops
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RetryLoopConfig {
    /// No retry - run once
    #[default]
    None,
    /// Retry up to max_attempts times
    MaxAttempts { max_attempts: usize },
    /// Retry based on submission presence
    SubmissionPresence {
        max_attempts: usize,
        #[serde(default = "default_threshold")]
        threshold: f64,
    },
    /// Retry based on patch presence
    PatchPresence {
        max_attempts: usize,
        #[serde(default = "default_min_lines")]
        min_lines: usize,
    },
}

/// Create a retry loop from configuration
pub fn get_retry_loop_from_config(config: &RetryLoopConfig) -> Box<dyn RetryLoop> {
    match config {
        RetryLoopConfig::None => Box::new(MaxAttemptsRetryLoop::new(1)),
        RetryLoopConfig::MaxAttempts { max_attempts } => {
            Box::new(MaxAttemptsRetryLoop::new(*max_attempts))
        }
        RetryLoopConfig::SubmissionPresence {
            max_attempts,
            threshold,
        } => Box::new(ReviewerRetryLoop::new(
            *max_attempts,
            Box::new(SubmissionPresenceReviewer::new(*threshold)),
            *threshold,
        )),
        RetryLoopConfig::PatchPresence {
            max_attempts,
            min_lines,
        } => Box::new(ReviewerRetryLoop::new(
            *max_attempts,
            Box::new(PatchPresenceReviewer::new(*min_lines)),
            0.5,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_pass_through_reviewer() {
        let reviewer = PassThroughReviewer;
        let submission = ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: Some("test patch".to_string()),
        };

        let result = reviewer.review(&submission).await.unwrap();
        assert_eq!(result.score, 1.0);
        assert!(!result.should_retry);
    }

    #[tokio::test]
    async fn test_submission_presence_reviewer() {
        let reviewer = SubmissionPresenceReviewer::new(0.5);

        // With submission
        let with_sub = ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: Some("patch content".to_string()),
        };
        let result = reviewer.review(&with_sub).await.unwrap();
        assert_eq!(result.score, 1.0);
        assert!(!result.should_retry);

        // Without submission
        let no_sub = ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: None,
        };
        let result = reviewer.review(&no_sub).await.unwrap();
        assert_eq!(result.score, 0.0);
        assert!(result.should_retry);
    }

    #[tokio::test]
    async fn test_patch_presence_reviewer() {
        let reviewer = PatchPresenceReviewer::new(2);

        // Valid patch
        let valid = ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: Some("--- a/file.py\n+++ b/file.py\n+new line\n-old line".to_string()),
        };
        let result = reviewer.review(&valid).await.unwrap();
        assert_eq!(result.score, 1.0);

        // Invalid patch (no diff content)
        let invalid = ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: Some("just some text\nno diff here".to_string()),
        };
        let result = reviewer.review(&invalid).await.unwrap();
        assert_eq!(result.score, 0.0);
    }

    #[tokio::test]
    async fn test_simple_chooser() {
        let chooser = SimpleChooser;
        let submissions = vec![
            ReviewSubmission {
                trajectory: vec![],
                info: AgentInfo::default(),
                submission: None,
            },
            ReviewSubmission {
                trajectory: vec![],
                info: AgentInfo::default(),
                submission: Some("a longer patch content here".to_string()),
            },
        ];

        let result = chooser.choose(&submissions).await.unwrap();
        assert_eq!(result.best_index, 1);
    }

    #[test]
    fn test_max_attempts_retry_loop() {
        let mut loop_runner = MaxAttemptsRetryLoop::new(3);

        assert!(loop_runner.should_retry());

        loop_runner.on_submit(ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: None,
        });
        assert!(loop_runner.should_retry());

        loop_runner.on_submit(ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: Some("patch".to_string()),
        });
        assert!(loop_runner.should_retry());

        loop_runner.on_submit(ReviewSubmission {
            trajectory: vec![],
            info: AgentInfo::default(),
            submission: None,
        });
        assert!(!loop_runner.should_retry());

        // Best should be index 1 (the one with submission)
        assert_eq!(loop_runner.get_best(), Some(1));
    }
}
