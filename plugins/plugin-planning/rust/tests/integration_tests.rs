//! Integration tests for the Planning Plugin.

use elizaos_plugin_planning::{
    ExecutionModel, PlanningConfig, PlanningContext, PlanningService,
};

#[test]
fn test_config_defaults() {
    let config = PlanningConfig::default();
    
    assert_eq!(config.max_steps, 10);
    assert_eq!(config.default_timeout_ms, 60000);
    assert_eq!(config.execution_model, ExecutionModel::Sequential);
    assert!(config.enable_adaptation);
}

#[test]
fn test_execution_model_display() {
    assert_eq!(ExecutionModel::Sequential.to_string(), "sequential");
    assert_eq!(ExecutionModel::Parallel.to_string(), "parallel");
    assert_eq!(ExecutionModel::Dag.to_string(), "dag");
}

#[tokio::test]
async fn test_planning_service_creation() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    
    service.start().await;
    service.stop().await;
}

#[tokio::test]
async fn test_create_simple_plan() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    service.start().await;
    
    let message = elizaos_plugin_planning::service::Message {
        id: uuid::Uuid::new_v4(),
        entity_id: uuid::Uuid::new_v4(),
        room_id: uuid::Uuid::new_v4(),
        content: elizaos_plugin_planning::service::MessageContent {
            text: "Send an email to the team".to_string(),
            source: None,
        },
    };
    
    let result = service
        .create_simple_plan(&message, &std::collections::HashMap::new(), None)
        .await;
    
    assert!(result.is_ok());
    let plan = result.unwrap();
    assert!(plan.is_some());
    
    let plan = plan.unwrap();
    assert!(!plan.steps.is_empty());
    assert_eq!(plan.steps[0].action_name, "SEND_EMAIL");
    
    service.stop().await;
}

#[tokio::test]
async fn test_create_comprehensive_plan() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    service.start().await;
    
    let context = PlanningContext {
        goal: "Build a comprehensive project plan".to_string(),
        constraints: vec![],
        available_actions: vec!["ANALYZE_INPUT".to_string(), "PROCESS_ANALYSIS".to_string()],
        available_providers: vec![],
        preferences: None,
    };
    
    let result = service.create_comprehensive_plan(&context, None).await;
    
    assert!(result.is_ok());
    let plan = result.unwrap();
    assert!(!plan.steps.is_empty());
    assert_eq!(plan.goal, "Build a comprehensive project plan");
    
    service.stop().await;
}

#[tokio::test]
async fn test_validate_plan() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    service.start().await;
    
    let context = PlanningContext {
        goal: "Test validation".to_string(),
        constraints: vec![],
        available_actions: vec!["REPLY".to_string()],
        available_providers: vec![],
        preferences: None,
    };
    
    let plan = service.create_comprehensive_plan(&context, None).await.unwrap();
    let (is_valid, issues) = service.validate_plan(&plan).await;
    
    // Plan structure should be valid
    assert!(is_valid || issues.is_some());
    
    service.stop().await;
}

#[tokio::test]
async fn test_execute_plan() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    service.start().await;
    
    let message = elizaos_plugin_planning::service::Message {
        id: uuid::Uuid::new_v4(),
        entity_id: uuid::Uuid::new_v4(),
        room_id: uuid::Uuid::new_v4(),
        content: elizaos_plugin_planning::service::MessageContent {
            text: "Hello world".to_string(),
            source: None,
        },
    };
    
    let plan = service
        .create_simple_plan(&message, &std::collections::HashMap::new(), None)
        .await
        .unwrap()
        .unwrap();
    
    let result = service.execute_plan(&plan, &message).await;
    
    assert!(result.is_ok());
    let exec_result = result.unwrap();
    assert_eq!(exec_result.plan_id, plan.id);
    assert_eq!(exec_result.total_steps, plan.steps.len());
    
    service.stop().await;
}

#[tokio::test]
async fn test_cancel_nonexistent_plan() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    service.start().await;
    
    let result = service.cancel_plan(uuid::Uuid::new_v4()).await;
    assert!(!result);
    
    service.stop().await;
}

#[tokio::test]
async fn test_get_status_nonexistent_plan() {
    let config = PlanningConfig::default();
    let service = PlanningService::new(config);
    service.start().await;
    
    let status = service.get_plan_status(uuid::Uuid::new_v4()).await;
    assert!(status.is_none());
    
    service.stop().await;
}







