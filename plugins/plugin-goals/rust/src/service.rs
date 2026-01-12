//! Goal service implementation
//!
//! Provides the main GoalService for managing goals.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info};
use uuid::Uuid;

use crate::error::{GoalError, Result};
use crate::types::{CreateGoalParams, Goal, GoalFilters, GoalOwnerType, UpdateGoalParams};

/// Database protocol trait
#[async_trait]
pub trait Database: Send + Sync {
    /// Execute a query and return results
    async fn execute(
        &self,
        query: &str,
        params: HashMap<String, serde_json::Value>,
    ) -> Result<Vec<HashMap<String, serde_json::Value>>>;

    /// Execute a query and return a single result
    async fn execute_one(
        &self,
        query: &str,
        params: HashMap<String, serde_json::Value>,
    ) -> Result<Option<HashMap<String, serde_json::Value>>>;
}

/// In-memory database for testing
pub struct InMemoryDatabase {
    goals: Arc<RwLock<HashMap<String, Goal>>>,
}

impl InMemoryDatabase {
    /// Create a new in-memory database
    pub fn new() -> Self {
        Self {
            goals: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Insert a goal
    pub async fn insert_goal(&self, goal: Goal) {
        let mut goals = self.goals.write().await;
        goals.insert(goal.id.clone(), goal);
    }

    /// Get a goal by ID
    pub async fn get_goal(&self, id: &str) -> Option<Goal> {
        let goals = self.goals.read().await;
        goals.get(id).cloned()
    }

    /// Get all goals
    pub async fn get_all_goals(&self) -> Vec<Goal> {
        let goals = self.goals.read().await;
        goals.values().cloned().collect()
    }

    /// Update a goal
    pub async fn update_goal(&self, id: &str, updates: UpdateGoalParams) -> Option<Goal> {
        let mut goals = self.goals.write().await;
        if let Some(goal) = goals.get_mut(id) {
            if let Some(name) = updates.name {
                goal.name = name;
            }
            if let Some(description) = updates.description {
                goal.description = Some(description);
            }
            if let Some(is_completed) = updates.is_completed {
                goal.is_completed = is_completed;
            }
            if let Some(completed_at) = updates.completed_at {
                goal.completed_at = Some(completed_at);
            }
            if let Some(metadata) = updates.metadata {
                goal.metadata = metadata;
            }
            if let Some(tags) = updates.tags {
                goal.tags = tags;
            }
            goal.updated_at = Utc::now();
            return Some(goal.clone());
        }
        None
    }

    /// Delete a goal
    pub async fn delete_goal(&self, id: &str) -> bool {
        let mut goals = self.goals.write().await;
        goals.remove(id).is_some()
    }
}

impl Default for InMemoryDatabase {
    fn default() -> Self {
        Self::new()
    }
}

/// Goal service for elizaOS
///
/// Manages goal CRUD operations.
pub struct GoalService {
    db: Arc<InMemoryDatabase>,
}

impl GoalService {
    /// Create a new goal service
    pub fn new(db: Arc<InMemoryDatabase>) -> Self {
        Self { db }
    }

    /// Create a new goal
    pub async fn create_goal(&self, params: CreateGoalParams) -> Result<Goal> {
        // Validate params
        if params.name.is_empty() {
            return Err(GoalError::ValidationError("Goal name cannot be empty".to_string()));
        }

        let now = Utc::now();
        let goal = Goal {
            id: Uuid::new_v4().to_string(),
            agent_id: params.agent_id,
            owner_type: params.owner_type,
            owner_id: params.owner_id,
            name: params.name,
            description: params.description,
            is_completed: false,
            completed_at: None,
            created_at: now,
            updated_at: now,
            metadata: params.metadata,
            tags: params.tags,
        };

        self.db.insert_goal(goal.clone()).await;

        info!("Created goal: {}", goal.id);
        Ok(goal)
    }

    /// Get a goal by ID
    pub async fn get_goal(&self, id: &str) -> Result<Goal> {
        self.db
            .get_goal(id)
            .await
            .ok_or_else(|| GoalError::NotFound(id.to_string()))
    }

    /// Get goals with optional filters
    pub async fn get_goals(&self, filters: Option<GoalFilters>) -> Result<Vec<Goal>> {
        let all_goals = self.db.get_all_goals().await;

        let filtered: Vec<Goal> = all_goals
            .into_iter()
            .filter(|goal| {
                if let Some(ref f) = filters {
                    // Filter by owner_type
                    if let Some(ref owner_type) = f.owner_type {
                        if &goal.owner_type != owner_type {
                            return false;
                        }
                    }
                    // Filter by owner_id
                    if let Some(ref owner_id) = f.owner_id {
                        if &goal.owner_id != owner_id {
                            return false;
                        }
                    }
                    // Filter by is_completed
                    if let Some(is_completed) = f.is_completed {
                        if goal.is_completed != is_completed {
                            return false;
                        }
                    }
                    // Filter by tags
                    if let Some(ref tags) = f.tags {
                        if !tags.iter().any(|t| goal.tags.contains(t)) {
                            return false;
                        }
                    }
                }
                true
            })
            .collect();

        Ok(filtered)
    }

    /// Update a goal
    pub async fn update_goal(&self, id: &str, updates: UpdateGoalParams) -> Result<Goal> {
        self.db
            .update_goal(id, updates)
            .await
            .ok_or_else(|| GoalError::NotFound(id.to_string()))
    }

    /// Delete a goal
    pub async fn delete_goal(&self, id: &str) -> Result<()> {
        if self.db.delete_goal(id).await {
            info!("Deleted goal: {}", id);
            Ok(())
        } else {
            Err(GoalError::NotFound(id.to_string()))
        }
    }

    /// Complete a goal
    pub async fn complete_goal(&self, id: &str) -> Result<Goal> {
        let goal = self.get_goal(id).await?;

        if goal.is_completed {
            return Err(GoalError::AlreadyCompleted(id.to_string()));
        }

        let updates = UpdateGoalParams::new().with_completed(true);
        self.update_goal(id, updates).await
    }

    /// Cancel a goal
    pub async fn cancel_goal(&self, id: &str) -> Result<()> {
        let goal = self.get_goal(id).await?;

        if goal.is_completed {
            return Err(GoalError::AlreadyCompleted(id.to_string()));
        }

        self.delete_goal(id).await
    }

    /// Get uncompleted goals
    pub async fn get_uncompleted_goals(
        &self,
        owner_type: Option<GoalOwnerType>,
        owner_id: Option<String>,
    ) -> Result<Vec<Goal>> {
        let filters = GoalFilters {
            owner_type,
            owner_id,
            is_completed: Some(false),
            tags: None,
        };
        self.get_goals(Some(filters)).await
    }

    /// Get completed goals
    pub async fn get_completed_goals(
        &self,
        owner_type: Option<GoalOwnerType>,
        owner_id: Option<String>,
    ) -> Result<Vec<Goal>> {
        let filters = GoalFilters {
            owner_type,
            owner_id,
            is_completed: Some(true),
            tags: None,
        };
        self.get_goals(Some(filters)).await
    }

    /// Count goals
    pub async fn count_goals(
        &self,
        owner_type: GoalOwnerType,
        owner_id: String,
        is_completed: Option<bool>,
    ) -> Result<usize> {
        let filters = GoalFilters {
            owner_type: Some(owner_type),
            owner_id: Some(owner_id),
            is_completed,
            tags: None,
        };
        let goals = self.get_goals(Some(filters)).await?;
        Ok(goals.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_goal() {
        let db = Arc::new(InMemoryDatabase::new());
        let service = GoalService::new(db);

        let params = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Entity,
            "user-456".to_string(),
            "Learn Rust".to_string(),
        );

        let goal = service.create_goal(params).await.unwrap();
        assert_eq!(goal.name, "Learn Rust");
        assert!(!goal.is_completed);
    }

    #[tokio::test]
    async fn test_get_goal() {
        let db = Arc::new(InMemoryDatabase::new());
        let service = GoalService::new(db);

        let params = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Entity,
            "user-456".to_string(),
            "Learn Rust".to_string(),
        );

        let created = service.create_goal(params).await.unwrap();
        let retrieved = service.get_goal(&created.id).await.unwrap();

        assert_eq!(created.id, retrieved.id);
    }

    #[tokio::test]
    async fn test_complete_goal() {
        let db = Arc::new(InMemoryDatabase::new());
        let service = GoalService::new(db);

        let params = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Entity,
            "user-456".to_string(),
            "Learn Rust".to_string(),
        );

        let goal = service.create_goal(params).await.unwrap();
        let completed = service.complete_goal(&goal.id).await.unwrap();

        assert!(completed.is_completed);
        assert!(completed.completed_at.is_some());
    }

    #[tokio::test]
    async fn test_filter_goals() {
        let db = Arc::new(InMemoryDatabase::new());
        let service = GoalService::new(db);

        // Create some goals
        let params1 = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Entity,
            "user-456".to_string(),
            "Goal 1".to_string(),
        );
        let params2 = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Agent,
            "agent-123".to_string(),
            "Goal 2".to_string(),
        );

        service.create_goal(params1).await.unwrap();
        service.create_goal(params2).await.unwrap();

        // Filter by owner type
        let filters = GoalFilters::new().with_owner_type(GoalOwnerType::Entity);
        let goals = service.get_goals(Some(filters)).await.unwrap();

        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].name, "Goal 1");
    }
}
