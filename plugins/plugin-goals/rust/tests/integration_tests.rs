//! Integration tests for elizaOS Plugin Goals
//!
//! These tests verify goal operations work correctly.

use std::sync::Arc;

use elizaos_plugin_goals::{
    service::{GoalService, InMemoryDatabase},
    CreateGoalParams, GoalFilters, GoalOwnerType, UpdateGoalParams,
};

/// Test goal CRUD operations
#[tokio::test]
async fn test_goal_crud() {
    let db = Arc::new(InMemoryDatabase::new());
    let service = GoalService::new(db);

    // Create
    let params = CreateGoalParams::new(
        "agent-123".to_string(),
        GoalOwnerType::Entity,
        "user-456".to_string(),
        "Learn Rust".to_string(),
    )
    .with_description("Master the Rust programming language".to_string())
    .with_tags(vec!["learning".to_string(), "programming".to_string()]);

    let goal = service.create_goal(params).await.unwrap();
    assert_eq!(goal.name, "Learn Rust");
    assert!(!goal.is_completed);

    // Read
    let retrieved = service.get_goal(&goal.id).await.unwrap();
    assert_eq!(retrieved.id, goal.id);

    // Update
    let updates = UpdateGoalParams::new()
        .with_name("Master Rust".to_string())
        .with_description("Become a Rust expert".to_string());
    let updated = service.update_goal(&goal.id, updates).await.unwrap();
    assert_eq!(updated.name, "Master Rust");

    // Delete
    service.delete_goal(&goal.id).await.unwrap();
    let result = service.get_goal(&goal.id).await;
    assert!(result.is_err());
}

/// Test goal completion
#[tokio::test]
async fn test_goal_completion() {
    let db = Arc::new(InMemoryDatabase::new());
    let service = GoalService::new(db);

    let params = CreateGoalParams::new(
        "agent-123".to_string(),
        GoalOwnerType::Entity,
        "user-456".to_string(),
        "Learn Rust".to_string(),
    );

    let goal = service.create_goal(params).await.unwrap();
    assert!(!goal.is_completed);

    let completed = service.complete_goal(&goal.id).await.unwrap();
    assert!(completed.is_completed);
    assert!(completed.completed_at.is_some());

    // Cannot complete again
    let result = service.complete_goal(&goal.id).await;
    assert!(result.is_err());
}

/// Test goal filtering
#[tokio::test]
async fn test_goal_filtering() {
    let db = Arc::new(InMemoryDatabase::new());
    let service = GoalService::new(db);

    // Create goals with different owners
    let params1 = CreateGoalParams::new(
        "agent-123".to_string(),
        GoalOwnerType::Entity,
        "user-456".to_string(),
        "User Goal 1".to_string(),
    );
    let params2 = CreateGoalParams::new(
        "agent-123".to_string(),
        GoalOwnerType::Entity,
        "user-456".to_string(),
        "User Goal 2".to_string(),
    );
    let params3 = CreateGoalParams::new(
        "agent-123".to_string(),
        GoalOwnerType::Agent,
        "agent-123".to_string(),
        "Agent Goal".to_string(),
    );

    service.create_goal(params1).await.unwrap();
    let goal2 = service.create_goal(params2).await.unwrap();
    service.create_goal(params3).await.unwrap();

    // Complete one goal
    service.complete_goal(&goal2.id).await.unwrap();

    // Filter by owner type
    let filters = GoalFilters::new().with_owner_type(GoalOwnerType::Entity);
    let entity_goals = service.get_goals(Some(filters)).await.unwrap();
    assert_eq!(entity_goals.len(), 2);

    // Filter by completion status
    let filters = GoalFilters::new().with_completed(false);
    let uncompleted = service.get_goals(Some(filters)).await.unwrap();
    assert_eq!(uncompleted.len(), 2);

    // Get uncompleted goals for specific owner
    let uncompleted = service
        .get_uncompleted_goals(Some(GoalOwnerType::Entity), Some("user-456".to_string()))
        .await
        .unwrap();
    assert_eq!(uncompleted.len(), 1);
}

/// Test goal counting
#[tokio::test]
async fn test_goal_counting() {
    let db = Arc::new(InMemoryDatabase::new());
    let service = GoalService::new(db);

    // Create goals
    for i in 1..=5 {
        let params = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Entity,
            "user-456".to_string(),
            format!("Goal {}", i),
        );
        let goal = service.create_goal(params).await.unwrap();

        // Complete even-numbered goals
        if i % 2 == 0 {
            service.complete_goal(&goal.id).await.unwrap();
        }
    }

    // Count all
    let total = service
        .count_goals(GoalOwnerType::Entity, "user-456".to_string(), None)
        .await
        .unwrap();
    assert_eq!(total, 5);

    // Count completed
    let completed = service
        .count_goals(GoalOwnerType::Entity, "user-456".to_string(), Some(true))
        .await
        .unwrap();
    assert_eq!(completed, 2);

    // Count uncompleted
    let uncompleted = service
        .count_goals(GoalOwnerType::Entity, "user-456".to_string(), Some(false))
        .await
        .unwrap();
    assert_eq!(uncompleted, 3);
}

/// Test action validation
#[tokio::test]
async fn test_create_goal_action() {
    use elizaos_plugin_goals::actions::{ActionContext, CreateGoalAction, GoalAction};
    use serde_json::json;

    let action = CreateGoalAction;

    // Valid context with extracted goal
    let context = ActionContext {
        message: json!({}),
        agent_id: "agent-123".to_string(),
        entity_id: "user-456".to_string(),
        room_id: None,
        state: json!({
            "extracted_goal": {
                "name": "Learn Rust",
                "description": "Master the language"
            }
        }),
    };

    let is_valid = action.validate(&context).await.unwrap();
    assert!(is_valid);

    let result = action.execute(&context).await.unwrap();
    assert_eq!(result["goal"]["name"], "Learn Rust");
}

/// Test provider output
#[tokio::test]
async fn test_goals_state_provider() {
    use elizaos_plugin_goals::providers::{GoalProvider, GoalsStateProvider, ProviderContext};

    let provider = GoalsStateProvider;
    let context = ProviderContext {
        agent_id: Some("agent-123".to_string()),
        entity_id: Some("user-456".to_string()),
        room_id: Some("room-789".to_string()),
    };

    let state = provider.get(&context).await;
    assert_eq!(state["agent_id"], "agent-123");
    assert_eq!(state["entity_id"], "user-456");
    assert_eq!(state["has_context"], true);
}
