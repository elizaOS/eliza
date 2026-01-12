//! Integration tests for linear plugin.

use elizaos_plugin_linear::types::{
    ActionResult, IssueInput, Label, LinearConfig, ProviderResult, ResourceType, SearchFilters,
    Team, User, WorkflowState,
};

#[test]
fn test_linear_config_new() {
    let config = LinearConfig {
        api_key: "test-key".to_string(),
        workspace_id: Some("ws-123".to_string()),
        default_team_key: Some("ENG".to_string()),
    };

    assert_eq!(config.api_key, "test-key");
    assert_eq!(config.workspace_id, Some("ws-123".to_string()));
    assert_eq!(config.default_team_key, Some("ENG".to_string()));
}

#[test]
fn test_resource_type_display() {
    assert_eq!(format!("{}", ResourceType::Issue), "issue");
    assert_eq!(format!("{}", ResourceType::Project), "project");
    assert_eq!(format!("{}", ResourceType::Comment), "comment");
    assert_eq!(format!("{}", ResourceType::Label), "label");
    assert_eq!(format!("{}", ResourceType::User), "user");
    assert_eq!(format!("{}", ResourceType::Team), "team");
}

#[test]
fn test_resource_type_serialization() {
    let resource = ResourceType::Issue;
    let json = serde_json::to_string(&resource).unwrap();
    assert_eq!(json, "\"issue\"");
}

#[test]
fn test_issue_input_default() {
    let input = IssueInput::default();
    assert!(input.title.is_empty());
    assert!(input.team_id.is_empty());
    assert!(input.description.is_none());
    assert!(input.priority.is_none());
    assert!(input.label_ids.is_empty());
}

#[test]
fn test_search_filters_default() {
    let filters = SearchFilters::default();
    assert!(filters.state.is_none());
    assert!(filters.assignee.is_none());
    assert!(filters.label.is_none());
    assert!(filters.project.is_none());
    assert!(filters.team.is_none());
    assert!(filters.query.is_none());
    assert!(filters.limit.is_none());
}

#[test]
fn test_team_serialization() {
    let team = Team {
        id: "team-1".to_string(),
        name: "Engineering".to_string(),
        key: "ENG".to_string(),
        description: Some("Engineering team".to_string()),
    };

    let json = serde_json::to_string(&team).unwrap();
    assert!(json.contains("team-1"));
    assert!(json.contains("Engineering"));
    assert!(json.contains("ENG"));
}

#[test]
fn test_user_serialization() {
    let user = User {
        id: "user-1".to_string(),
        name: "John Doe".to_string(),
        email: "john@example.com".to_string(),
    };

    let json = serde_json::to_string(&user).unwrap();
    assert!(json.contains("user-1"));
    assert!(json.contains("John Doe"));
    assert!(json.contains("john@example.com"));
}

#[test]
fn test_workflow_state_serialization() {
    let state = WorkflowState {
        id: "state-1".to_string(),
        name: "In Progress".to_string(),
        state_type: "started".to_string(),
        color: "#0000FF".to_string(),
    };

    let json = serde_json::to_string(&state).unwrap();
    assert!(json.contains("In Progress"));
    assert!(json.contains("started"));
}

#[test]
fn test_label_serialization() {
    let label = Label {
        id: "label-1".to_string(),
        name: "Bug".to_string(),
        color: "#FF0000".to_string(),
    };

    let json = serde_json::to_string(&label).unwrap();
    assert!(json.contains("Bug"));
    assert!(json.contains("#FF0000"));
}

#[test]
fn test_action_result_success() {
    let result = ActionResult::success("Operation completed");
    assert!(result.success);
    assert_eq!(result.text, "Operation completed");
    assert!(result.data.is_none());
}

#[test]
fn test_action_result_success_with_data() {
    let data = serde_json::json!({"id": "123"});
    let result = ActionResult::success_with_data("Created issue", data.clone());
    assert!(result.success);
    assert_eq!(result.text, "Created issue");
    assert!(result.data.is_some());
}

#[test]
fn test_action_result_error() {
    let result = ActionResult::error("Something went wrong");
    assert!(!result.success);
    assert_eq!(result.text, "Something went wrong");
    assert!(result.data.is_none());
}

#[test]
fn test_provider_result_new() {
    let result = ProviderResult::new("Provider data");
    assert_eq!(result.text, "Provider data");
    assert!(result.data.is_none());
}

#[test]
fn test_provider_result_with_data() {
    let data = serde_json::json!({"items": []});
    let result = ProviderResult::with_data("Found items", data.clone());
    assert_eq!(result.text, "Found items");
    assert!(result.data.is_some());
}
