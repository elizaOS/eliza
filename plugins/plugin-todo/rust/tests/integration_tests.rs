//! Integration tests for the Todo Plugin.

use chrono::{Duration, Utc};
use elizaos_plugin_todo::{
    actions::{CancelTodoAction, CompleteTodoAction, CreateTodoAction, UpdateTodoAction},
    providers::TodosProvider,
    CacheManager, CreateTodoParams, Priority, TaskType, TodoClient, TodoConfig, TodoDataService,
    TodoFilters, UpdateTodoParams,
};
use std::sync::Arc;
use uuid::Uuid;

fn test_uuids() -> (Uuid, Uuid, Uuid, Uuid) {
    (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
}

#[tokio::test]
async fn test_create_and_get_todo() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Test Todo".to_string(),
        description: Some("A test todo item".to_string()),
        task_type: TaskType::OneOff,
        priority: Some(Priority::High),
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();
    assert_ne!(todo_id, Uuid::nil());

    let todo = service.get_todo(todo_id).await.unwrap();
    assert_eq!(todo.name, "Test Todo");
    assert_eq!(todo.task_type, TaskType::OneOff);
    assert_eq!(todo.priority, Some(Priority::High));
    assert!(!todo.is_completed);
}

#[tokio::test]
async fn test_update_todo() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Original Name".to_string(),
        task_type: TaskType::OneOff,
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();

    let updates = UpdateTodoParams {
        name: Some("Updated Name".to_string()),
        priority: Some(Priority::Critical),
        ..Default::default()
    };

    service.update_todo(todo_id, updates).await.unwrap();

    let todo = service.get_todo(todo_id).await.unwrap();
    assert_eq!(todo.name, "Updated Name");
    assert_eq!(todo.priority, Some(Priority::Critical));
}

#[tokio::test]
async fn test_complete_todo() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Complete Me".to_string(),
        task_type: TaskType::OneOff,
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();

    let updates = UpdateTodoParams {
        is_completed: Some(true),
        completed_at: Some(Utc::now()),
        ..Default::default()
    };

    service.update_todo(todo_id, updates).await.unwrap();

    let todo = service.get_todo(todo_id).await.unwrap();
    assert!(todo.is_completed);
    assert!(todo.completed_at.is_some());
}

#[tokio::test]
async fn test_delete_todo() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Delete Me".to_string(),
        task_type: TaskType::OneOff,
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();
    service.delete_todo(todo_id).await.unwrap();

    let todo = service.get_todo(todo_id).await;
    assert!(todo.is_none());
}

#[tokio::test]
async fn test_get_todos_with_filters() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    // Create multiple todos
    for i in 0..3 {
        let task_type = if i < 2 {
            TaskType::OneOff
        } else {
            TaskType::Daily
        };

        let params = CreateTodoParams {
            agent_id,
            world_id,
            room_id,
            entity_id,
            name: format!("Todo {}", i),
            task_type,
            ..Default::default()
        };

        service.create_todo(params).await.unwrap();
    }

    // Filter by type
    let filters = TodoFilters {
        task_type: Some(TaskType::OneOff),
        ..Default::default()
    };
    let todos = service.get_todos(Some(filters)).await;
    assert_eq!(todos.len(), 2);

    let filters = TodoFilters {
        task_type: Some(TaskType::Daily),
        ..Default::default()
    };
    let todos = service.get_todos(Some(filters)).await;
    assert_eq!(todos.len(), 1);
}

#[tokio::test]
async fn test_get_overdue_todos() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    // Create overdue todo
    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Overdue Task".to_string(),
        task_type: TaskType::OneOff,
        due_date: Some(Utc::now() - Duration::days(1)),
        ..Default::default()
    };
    service.create_todo(params).await.unwrap();

    // Create future todo
    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Future Task".to_string(),
        task_type: TaskType::OneOff,
        due_date: Some(Utc::now() + Duration::days(1)),
        ..Default::default()
    };
    service.create_todo(params).await.unwrap();

    let overdue = service.get_overdue_todos(None).await;
    assert_eq!(overdue.len(), 1);
    assert_eq!(overdue[0].name, "Overdue Task");
}

#[tokio::test]
async fn test_add_and_remove_tags() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = TodoDataService::new();

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Tagged Todo".to_string(),
        task_type: TaskType::OneOff,
        tags: vec!["initial".to_string()],
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();

    // Add tags
    service
        .add_tags(
            todo_id,
            vec!["new-tag".to_string(), "another-tag".to_string()],
        )
        .await
        .unwrap();

    let todo = service.get_todo(todo_id).await.unwrap();
    assert!(todo.tags.contains(&"new-tag".to_string()));
    assert!(todo.tags.contains(&"another-tag".to_string()));

    // Remove tags
    service
        .remove_tags(todo_id, vec!["new-tag".to_string()])
        .await
        .unwrap();

    let todo = service.get_todo(todo_id).await.unwrap();
    assert!(!todo.tags.contains(&"new-tag".to_string()));
    assert!(todo.tags.contains(&"another-tag".to_string()));
}

#[tokio::test]
async fn test_cache_manager() {
    let cache = CacheManager::from_ms(10, 60000);

    // Test set and get
    cache.set("key1", serde_json::json!("value1"), None).await;
    let value: serde_json::Value = cache.get("key1").await.unwrap();
    assert_eq!(value, serde_json::json!("value1"));

    // Test missing key
    let value: Option<serde_json::Value> = cache.get("nonexistent").await;
    assert!(value.is_none());

    // Test delete
    cache.delete("key1").await;
    let value: Option<serde_json::Value> = cache.get("key1").await;
    assert!(value.is_none());

    // Test has
    cache.set("key2", serde_json::json!("value2"), None).await;
    assert!(cache.has("key2").await);
    assert!(!cache.has("nonexistent").await);

    // Test stats
    let stats = cache.get_stats().await;
    assert!(stats.total_hits > 0 || stats.total_misses > 0);
}

#[tokio::test]
async fn test_config_validation() {
    let config = TodoConfig::default();
    assert!(config.validate().is_ok());

    let invalid_config = TodoConfig {
        reminder_interval_ms: 100, // Too small
        ..Default::default()
    };
    assert!(invalid_config.validate().is_err());
}

#[tokio::test]
async fn test_todo_client() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();

    let config = TodoConfig::default().with_reminders(false);
    let mut client = TodoClient::new(config).unwrap();
    client.start().await.unwrap();

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Client Test Todo".to_string(),
        task_type: TaskType::OneOff,
        priority: Some(Priority::High),
        ..Default::default()
    };

    let todo = client.create_todo(params).await.unwrap();
    assert_eq!(todo.name, "Client Test Todo");
    assert_eq!(todo.task_type, TaskType::OneOff);

    // Complete
    let completed = client.complete_todo(todo.id).await.unwrap();
    assert!(completed.is_completed);

    // Uncomplete
    let uncompleted = client.uncomplete_todo(todo.id).await.unwrap();
    assert!(!uncompleted.is_completed);

    // Delete
    client.delete_todo(todo.id).await.unwrap();
    let deleted = client.get_todo(todo.id).await;
    assert!(deleted.is_none());

    client.stop().await;
}

#[tokio::test]
async fn test_action_metadata() {
    // Test CREATE_TODO action metadata
    assert_eq!(CreateTodoAction::NAME, "CREATE_TODO");
    assert!(!CreateTodoAction::DESCRIPTION.is_empty());
    assert!(!CreateTodoAction::SIMILES.is_empty());
    assert!(CreateTodoAction::SIMILES.contains(&"CREATE_TODO"));
    assert!(CreateTodoAction::SIMILES.contains(&"ADD_TODO"));

    // Test COMPLETE_TODO action metadata
    assert_eq!(CompleteTodoAction::NAME, "COMPLETE_TODO");
    assert!(!CompleteTodoAction::DESCRIPTION.is_empty());
    assert!(!CompleteTodoAction::SIMILES.is_empty());
    assert!(CompleteTodoAction::SIMILES.contains(&"COMPLETE_TODO"));
    assert!(CompleteTodoAction::SIMILES.contains(&"MARK_COMPLETE"));

    // Test UPDATE_TODO action metadata
    assert_eq!(UpdateTodoAction::NAME, "UPDATE_TODO");
    assert!(!UpdateTodoAction::DESCRIPTION.is_empty());
    assert!(!UpdateTodoAction::SIMILES.is_empty());
    assert!(UpdateTodoAction::SIMILES.contains(&"UPDATE_TODO"));
    assert!(UpdateTodoAction::SIMILES.contains(&"EDIT_TODO"));

    // Test CANCEL_TODO action metadata
    assert_eq!(CancelTodoAction::NAME, "CANCEL_TODO");
    assert!(!CancelTodoAction::DESCRIPTION.is_empty());
    assert!(!CancelTodoAction::SIMILES.is_empty());
    assert!(CancelTodoAction::SIMILES.contains(&"CANCEL_TODO"));
    assert!(CancelTodoAction::SIMILES.contains(&"DELETE_TODO"));
}

#[tokio::test]
async fn test_provider_metadata() {
    // Test TODOS provider metadata
    assert_eq!(TodosProvider::NAME, "TODOS");
    assert!(!TodosProvider::DESCRIPTION.is_empty());
}

#[tokio::test]
async fn test_create_todo_action() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = Arc::new(TodoDataService::new());

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Action Test Todo".to_string(),
        description: Some("Testing create action".to_string()),
        task_type: TaskType::OneOff,
        priority: Some(Priority::High),
        ..Default::default()
    };

    let result = CreateTodoAction::handle(service.clone(), params).await;
    assert!(result.success);
    assert!(result.todo_id.is_some());
    assert!(result.text.contains("Created task"));
}

#[tokio::test]
async fn test_complete_todo_action() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = Arc::new(TodoDataService::new());

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Complete Me".to_string(),
        task_type: TaskType::OneOff,
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();

    let result = CompleteTodoAction::handle(service.clone(), room_id, Some(todo_id)).await;
    assert!(result.success);
    assert!(result.text.contains("Completed"));

    let todo = service.get_todo(todo_id).await.unwrap();
    assert!(todo.is_completed);
}

#[tokio::test]
async fn test_update_todo_action() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = Arc::new(TodoDataService::new());

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Update Me".to_string(),
        task_type: TaskType::OneOff,
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();

    let updates = UpdateTodoParams {
        name: Some("Updated Name".to_string()),
        priority: Some(Priority::Critical),
        ..Default::default()
    };

    let result = UpdateTodoAction::handle(service.clone(), room_id, todo_id, updates).await;
    assert!(result.success);
    assert!(result.text.contains("Updated"));

    let todo = service.get_todo(todo_id).await.unwrap();
    assert_eq!(todo.name, "Updated Name");
    assert_eq!(todo.priority, Some(Priority::Critical));
}

#[tokio::test]
async fn test_cancel_todo_action() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = Arc::new(TodoDataService::new());

    let params = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Cancel Me".to_string(),
        task_type: TaskType::OneOff,
        ..Default::default()
    };

    let todo_id = service.create_todo(params).await.unwrap();

    let result = CancelTodoAction::handle(service.clone(), room_id, todo_id).await;
    assert!(result.success);
    assert!(result.text.contains("cancelled"));

    let todo = service.get_todo(todo_id).await;
    assert!(todo.is_none());
}

#[tokio::test]
async fn test_todos_provider() {
    let (agent_id, world_id, room_id, entity_id) = test_uuids();
    let service = Arc::new(TodoDataService::new());

    // Create some todos
    let params1 = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "Daily Task".to_string(),
        task_type: TaskType::Daily,
        ..Default::default()
    };
    service.create_todo(params1).await.unwrap();

    let params2 = CreateTodoParams {
        agent_id,
        world_id,
        room_id,
        entity_id,
        name: "One-Off Task".to_string(),
        task_type: TaskType::OneOff,
        priority: Some(Priority::High),
        ..Default::default()
    };
    service.create_todo(params2).await.unwrap();

    let result = TodosProvider::get(service.clone(), entity_id, Some(room_id)).await;
    assert!(!result.text.is_empty());
    assert!(result.values.contains_key("dailyTasks"));
    assert!(result.values.contains_key("oneOffTasks"));
    assert!(result.data.contains_key("dailyTodos"));
    assert!(result.data.contains_key("oneOffTodos"));
}
