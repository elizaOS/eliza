//! Follow-up service implementation.

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;

use super::{Service, ServiceType};

/// Follow-up task data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowUpTask {
    pub entity_id: Uuid,
    pub reason: String,
    pub message: Option<String>,
    pub priority: String,
    pub scheduled_at: DateTime<Utc>,
}

/// Follow-up suggestion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowUpSuggestion {
    pub entity_id: Uuid,
    pub entity_name: String,
    pub days_since_last_contact: i64,
    pub relationship_strength: f64,
    pub suggested_reason: String,
}

/// Service for managing follow-up reminders.
pub struct FollowUpService {
    follow_ups: HashMap<Uuid, FollowUpTask>,
    runtime: Option<Arc<dyn IAgentRuntime>>,
}

impl FollowUpService {
    /// Create a new follow-up service.
    pub fn new() -> Self {
        Self {
            follow_ups: HashMap::new(),
            runtime: None,
        }
    }

    /// Schedule a follow-up.
    pub fn schedule_follow_up(
        &mut self,
        entity_id: Uuid,
        scheduled_at: DateTime<Utc>,
        reason: String,
        priority: String,
        message: Option<String>,
    ) -> FollowUpTask {
        let task = FollowUpTask {
            entity_id,
            reason,
            message,
            priority,
            scheduled_at,
        };

        if let Some(runtime) = &self.runtime {
            runtime.log_info(
                "service:follow_up",
                &format!("Scheduled follow-up with {}", entity_id),
            );
        }

        self.follow_ups.insert(entity_id, task.clone());
        task
    }

    /// Get a follow-up by entity ID.
    pub fn get_follow_up(&self, entity_id: Uuid) -> Option<&FollowUpTask> {
        self.follow_ups.get(&entity_id)
    }

    /// Cancel a follow-up.
    pub fn cancel_follow_up(&mut self, entity_id: Uuid) -> bool {
        self.follow_ups.remove(&entity_id).is_some()
    }

    /// Get upcoming follow-ups.
    pub fn get_upcoming_follow_ups(
        &self,
        days_ahead: i64,
        include_overdue: bool,
    ) -> Vec<&FollowUpTask> {
        let now = Utc::now();
        let future = now + Duration::days(days_ahead);

        self.follow_ups
            .values()
            .filter(|t| {
                if include_overdue && t.scheduled_at < now {
                    return true;
                }
                t.scheduled_at >= now && t.scheduled_at <= future
            })
            .collect()
    }

    /// Get overdue follow-ups.
    pub fn get_overdue_follow_ups(&self) -> Vec<&FollowUpTask> {
        let now = Utc::now();
        self.follow_ups
            .values()
            .filter(|t| t.scheduled_at < now)
            .collect()
    }

    /// Complete a follow-up.
    pub fn complete_follow_up(&mut self, entity_id: Uuid) -> bool {
        self.cancel_follow_up(entity_id)
    }
}

impl Default for FollowUpService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for FollowUpService {
    fn name(&self) -> &'static str {
        "follow_up"
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("service:follow_up", "Follow-up service started");
        self.runtime = Some(runtime);
        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        if let Some(runtime) = &self.runtime {
            runtime.log_info("service:follow_up", "Follow-up service stopped");
        }
        self.follow_ups.clear();
        self.runtime = None;
        Ok(())
    }
}
