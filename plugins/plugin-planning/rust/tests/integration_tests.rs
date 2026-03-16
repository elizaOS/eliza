//! Integration tests for planning plugin.

use elizaos_plugin_planning::types::{
    decode_plan, encode_plan, format_plan, generate_task_id, get_plan_progress, ActionResult,
    Plan, PlanStatus, ProviderResult, Task, TaskStatus,
};

fn make_test_plan(task_statuses: &[TaskStatus]) -> Plan {
    let now = chrono::Utc::now().timestamp_millis();
    Plan {
        id: "plan-test".to_string(),
        title: "Test Plan".to_string(),
        description: "A test plan".to_string(),
        status: PlanStatus::Active,
        tasks: task_statuses
            .iter()
            .enumerate()
            .map(|(i, status)| Task {
                id: generate_task_id(i),
                title: format!("Task {}", i + 1),
                description: String::new(),
                status: *status,
                order: (i + 1) as i32,
                dependencies: Vec::new(),
                assignee: None,
                created_at: now,
                completed_at: if *status == TaskStatus::Completed {
                    Some(now)
                } else {
                    None
                },
            })
            .collect(),
        created_at: now,
        updated_at: now,
        metadata: serde_json::json!({}),
    }
}

#[test]
fn test_task_status_display() {
    assert_eq!(format!("{}", TaskStatus::Pending), "pending");
    assert_eq!(format!("{}", TaskStatus::InProgress), "in_progress");
    assert_eq!(format!("{}", TaskStatus::Completed), "completed");
    assert_eq!(format!("{}", TaskStatus::Cancelled), "cancelled");
}

#[test]
fn test_plan_status_display() {
    assert_eq!(format!("{}", PlanStatus::Draft), "draft");
    assert_eq!(format!("{}", PlanStatus::Active), "active");
    assert_eq!(format!("{}", PlanStatus::Completed), "completed");
    assert_eq!(format!("{}", PlanStatus::Archived), "archived");
}

#[test]
fn test_task_status_serialization() {
    let status = TaskStatus::InProgress;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"in_progress\"");

    let deserialized: TaskStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, TaskStatus::InProgress);
}

#[test]
fn test_plan_status_serialization() {
    let status = PlanStatus::Active;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"active\"");

    let deserialized: PlanStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, PlanStatus::Active);
}

#[test]
fn test_generate_task_id() {
    assert_eq!(generate_task_id(0), "task-1");
    assert_eq!(generate_task_id(1), "task-2");
    assert_eq!(generate_task_id(9), "task-10");
}

#[test]
fn test_encode_decode_plan_roundtrip() {
    let plan = make_test_plan(&[TaskStatus::Pending, TaskStatus::Completed]);

    let encoded = encode_plan(&plan);
    let decoded = decode_plan(&encoded);

    assert!(decoded.is_some());
    let decoded = decoded.unwrap();
    assert_eq!(decoded.id, plan.id);
    assert_eq!(decoded.title, plan.title);
    assert_eq!(decoded.tasks.len(), 2);
    assert_eq!(decoded.tasks[0].status, TaskStatus::Pending);
    assert_eq!(decoded.tasks[1].status, TaskStatus::Completed);
}

#[test]
fn test_decode_invalid_plan() {
    assert!(decode_plan("not json").is_none());
    assert!(decode_plan("{}").is_none());
    assert!(decode_plan(r#"{"id":"x"}"#).is_none());
}

#[test]
fn test_plan_progress_empty() {
    let plan = make_test_plan(&[]);
    assert_eq!(get_plan_progress(&plan), 0);
}

#[test]
fn test_plan_progress_none_completed() {
    let plan = make_test_plan(&[TaskStatus::Pending, TaskStatus::Pending]);
    assert_eq!(get_plan_progress(&plan), 0);
}

#[test]
fn test_plan_progress_all_completed() {
    let plan = make_test_plan(&[TaskStatus::Completed, TaskStatus::Completed]);
    assert_eq!(get_plan_progress(&plan), 100);
}

#[test]
fn test_plan_progress_partial() {
    let plan = make_test_plan(&[TaskStatus::Completed, TaskStatus::Pending]);
    assert_eq!(get_plan_progress(&plan), 50);
}

#[test]
fn test_plan_progress_two_thirds() {
    let plan = make_test_plan(&[
        TaskStatus::Completed,
        TaskStatus::Completed,
        TaskStatus::Pending,
    ]);
    assert_eq!(get_plan_progress(&plan), 67);
}

#[test]
fn test_format_plan() {
    let mut plan = make_test_plan(&[TaskStatus::Completed, TaskStatus::Pending]);
    plan.title = "Launch Plan".to_string();
    plan.description = "Launch the website".to_string();
    plan.tasks[1].assignee = Some("alice".to_string());

    let formatted = format_plan(&plan);
    assert!(formatted.contains("Launch Plan"));
    assert!(formatted.contains("50%"));
    assert!(formatted.contains("[x] Task 1"));
    assert!(formatted.contains("[ ] Task 2"));
    assert!(formatted.contains("@alice"));
}

#[test]
fn test_format_plan_with_in_progress() {
    let plan = make_test_plan(&[TaskStatus::InProgress]);
    let formatted = format_plan(&plan);
    assert!(formatted.contains("[~] Task 1"));
}

#[test]
fn test_format_plan_with_cancelled() {
    let plan = make_test_plan(&[TaskStatus::Cancelled]);
    let formatted = format_plan(&plan);
    assert!(formatted.contains("[-] Task 1"));
}

#[test]
fn test_action_result_success() {
    let result = ActionResult::success("Plan created");
    assert!(result.success);
    assert_eq!(result.text, "Plan created");
    assert!(result.data.is_none());
}

#[test]
fn test_action_result_success_with_data() {
    let data = serde_json::json!({"planId": "plan-1"});
    let result = ActionResult::success_with_data("Created", data);
    assert!(result.success);
    assert!(result.data.is_some());
}

#[test]
fn test_action_result_error() {
    let result = ActionResult::error("Failed");
    assert!(!result.success);
    assert_eq!(result.text, "Failed");
}

#[test]
fn test_provider_result_new() {
    let result = ProviderResult::new("No plans");
    assert_eq!(result.text, "No plans");
    assert!(result.data.is_none());
}

#[test]
fn test_provider_result_with_data() {
    let data = serde_json::json!({"count": 2});
    let result = ProviderResult::with_data("Found plans", data);
    assert_eq!(result.text, "Found plans");
    assert!(result.data.is_some());
}

#[tokio::test]
async fn test_create_plan_action() {
    let params = serde_json::json!({
        "title": "Test Plan",
        "description": "A test",
        "tasks": [
            {"title": "Task A", "description": "Do A"},
            {"title": "Task B", "description": "Do B"},
        ],
    });

    let result = elizaos_plugin_planning::actions::create_plan(params)
        .await
        .unwrap();
    assert!(result.success);
    assert!(result.text.contains("Test Plan"));
    assert!(result.text.contains("2 tasks"));
}

#[tokio::test]
async fn test_create_plan_missing_title() {
    let params = serde_json::json!({});
    let result = elizaos_plugin_planning::actions::create_plan(params).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_complete_task_action() {
    let plan = make_test_plan(&[TaskStatus::Pending]);
    let plan_json = encode_plan(&plan);

    let params = serde_json::json!({
        "plan": plan_json,
        "taskId": "task-1",
    });

    let result = elizaos_plugin_planning::actions::complete_task(params)
        .await
        .unwrap();
    assert!(result.success);
    assert!(result.text.contains("Completed task"));
    assert!(result.text.contains("100%"));
}

#[tokio::test]
async fn test_complete_task_already_done() {
    let plan = make_test_plan(&[TaskStatus::Completed]);
    let plan_json = encode_plan(&plan);

    let params = serde_json::json!({
        "plan": plan_json,
        "taskId": "task-1",
    });

    let result = elizaos_plugin_planning::actions::complete_task(params)
        .await
        .unwrap();
    assert!(result.success);
    assert!(result.text.contains("already completed"));
}

#[tokio::test]
async fn test_get_plan_no_plans() {
    let params = serde_json::json!({
        "plans": [],
    });

    let result = elizaos_plugin_planning::actions::get_plan(params)
        .await
        .unwrap();
    assert!(result.success);
    assert!(result.text.contains("No plans found"));
}

#[test]
fn test_plan_status_provider_empty() {
    let plan_texts: Vec<&str> = vec![];
    let result = elizaos_plugin_planning::providers::get_plan_status(&plan_texts).unwrap();
    assert!(result.text.contains("No active plans"));
}

#[test]
fn test_plan_status_provider_with_plans() {
    let plan = make_test_plan(&[TaskStatus::Completed, TaskStatus::Pending]);
    let encoded = encode_plan(&plan);
    let plan_texts = vec![encoded.as_str()];

    let result = elizaos_plugin_planning::providers::get_plan_status(&plan_texts).unwrap();
    assert!(result.text.contains("Active Plans (1)"));
    assert!(result.text.contains("50%"));
}

#[test]
fn test_plugin_metadata() {
    let plugin = elizaos_plugin_planning::PlanningPlugin::new();
    assert_eq!(plugin.name, "@elizaos/plugin-planning-rs");
    assert!(!plugin.description.is_empty());
    assert_eq!(
        elizaos_plugin_planning::PlanningPlugin::actions(),
        vec!["CREATE_PLAN", "UPDATE_PLAN", "COMPLETE_TASK", "GET_PLAN"]
    );
    assert_eq!(
        elizaos_plugin_planning::PlanningPlugin::providers(),
        vec!["PLAN_STATUS"]
    );
}
