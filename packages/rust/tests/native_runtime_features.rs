#![cfg(all(feature = "native", not(feature = "wasm")))]

use anyhow::Result;
use elizaos::runtime::{AgentRuntime, RuntimeModelHandler, RuntimeOptions};
use elizaos::types::agent::{Bio, Character};
use serde_json::Value;
use std::sync::Arc;

fn test_character() -> Character {
    Character {
        name: "NativeFeatureTest".to_string(),
        bio: Bio::Single("native feature test".to_string()),
        ..Default::default()
    }
}

#[tokio::test]
async fn native_runtime_features_register_by_default() -> Result<()> {
    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
        character: Some(test_character()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let plugin_names = runtime.list_plugin_names().await;
    assert!(plugin_names.contains(&"knowledge".to_string()));
    assert!(plugin_names.contains(&"relationships".to_string()));
    assert!(plugin_names.contains(&"trajectories".to_string()));

    assert!(runtime.is_knowledge_enabled().await);
    assert!(runtime.is_relationships_enabled().await);
    assert!(runtime.is_trajectories_enabled().await);

    let relationships = runtime
        .get_service("relationships")
        .await
        .expect("relationships");
    assert_eq!(relationships.service_type(), "relationships");

    let trajectories = runtime
        .get_service("trajectories")
        .await
        .expect("trajectories");
    let trajectories = runtime
        .get_service("trajectories")
        .await
        .expect("trajectories");
    assert!(Arc::ptr_eq(&trajectories, &trajectories));

    let providers = runtime
        .list_provider_definitions()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(providers.contains(&"KNOWLEDGE".to_string()));
    assert!(providers.contains(&"CONTACTS".to_string()));

    Ok(())
}

#[tokio::test]
async fn native_runtime_features_honor_constructor_disable_flags() -> Result<()> {
    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
        character: Some(test_character()),
        enable_knowledge: Some(false),
        enable_relationships: Some(false),
        enable_trajectories: Some(false),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    assert!(!runtime.is_knowledge_enabled().await);
    assert!(!runtime.is_relationships_enabled().await);
    assert!(!runtime.is_trajectories_enabled().await);

    let plugin_names = runtime.list_plugin_names().await;
    assert!(!plugin_names.contains(&"knowledge".to_string()));
    assert!(!plugin_names.contains(&"relationships".to_string()));
    assert!(!plugin_names.contains(&"trajectories".to_string()));

    assert!(runtime.get_service("relationships").await.is_none());
    assert!(runtime.get_service("follow_up").await.is_none());
    assert!(runtime.get_service("trajectories").await.is_none());

    let providers = runtime
        .list_provider_definitions()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(!providers.contains(&"KNOWLEDGE".to_string()));
    assert!(!providers.contains(&"CONTACTS".to_string()));

    Ok(())
}

#[tokio::test]
async fn native_runtime_features_can_toggle_after_initialize() -> Result<()> {
    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
        character: Some(test_character()),
        enable_knowledge: Some(false),
        enable_relationships: Some(false),
        enable_trajectories: Some(false),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    runtime.enable_relationships().await?;
    assert!(runtime.is_relationships_enabled().await);
    assert!(runtime.get_service("relationships").await.is_some());

    runtime.enable_knowledge().await?;
    assert!(runtime.is_knowledge_enabled().await);
    let providers = runtime
        .list_provider_definitions()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(providers.contains(&"KNOWLEDGE".to_string()));

    runtime.enable_trajectories().await?;
    assert!(runtime.is_trajectories_enabled().await);
    assert!(runtime.get_service("trajectories").await.is_some());

    runtime.disable_relationships().await?;
    assert!(!runtime.is_relationships_enabled().await);
    assert!(runtime.get_service("relationships").await.is_none());
    assert!(runtime.get_service("follow_up").await.is_none());

    runtime.disable_knowledge().await?;
    assert!(!runtime.is_knowledge_enabled().await);
    let providers = runtime
        .list_provider_definitions()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert!(!providers.contains(&"KNOWLEDGE".to_string()));

    Ok(())
}

#[tokio::test]
async fn trajectories_do_not_log_when_disabled() -> Result<()> {
    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
        character: Some(test_character()),
        enable_trajectories: Some(false),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let handler: RuntimeModelHandler = Box::new(|_params| Box::pin(async { Ok("ok".to_string()) }));
    runtime.register_model("TEXT_LARGE", handler).await;
    runtime.set_trajectory_step_id(Some("disabled-step".to_string()));

    let mut params = serde_json::Map::new();
    params.insert("prompt".to_string(), Value::String("hello".to_string()));
    let _ = runtime
        .use_model("TEXT_LARGE", Value::Object(params))
        .await?;

    let logs = runtime.get_trajectory_logs();
    assert!(logs.llm_calls.is_empty());

    runtime.enable_trajectories().await?;
    runtime.set_trajectory_step_id(Some("enabled-step".to_string()));

    let mut params = serde_json::Map::new();
    params.insert("prompt".to_string(), Value::String("hello".to_string()));
    let _ = runtime
        .use_model("TEXT_LARGE", Value::Object(params))
        .await?;

    let logs = runtime.get_trajectory_logs();
    assert_eq!(logs.llm_calls.len(), 1);
    assert_eq!(logs.llm_calls[0].step_id, "enabled-step");

    Ok(())
}
