#![cfg(all(feature = "native", not(feature = "wasm")))]

use anyhow::Result;
use async_trait::async_trait;
use elizaos::native_features::RelationshipsService;
use elizaos::runtime::{AgentRuntime, RuntimeModelHandler, RuntimeOptions};
use elizaos::types::agent::{Bio, Character};
use elizaos::types::{
    Content, Memory, Plugin, PluginDefinition, ProviderDefinition, ProviderHandler, ProviderResult,
    State, UUID,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

fn test_character() -> Character {
    Character {
        name: "NativeFeatureTest".to_string(),
        bio: Bio::Single("native feature test".to_string()),
        ..Default::default()
    }
}

fn test_message(text: &str) -> Memory {
    Memory {
        id: Some(UUID::new_v4()),
        entity_id: UUID::new_v4(),
        agent_id: None,
        room_id: UUID::new_v4(),
        world_id: None,
        content: Content {
            text: Some(text.to_string()),
            ..Default::default()
        },
        embedding: None,
        created_at: Some(chrono::Utc::now().timestamp_millis()),
        unique: Some(true),
        similarity: None,
        metadata: None,
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

#[tokio::test]
async fn native_relationship_search_matches_named_contacts_without_defaulting_to_acquaintances(
) -> Result<()> {
    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
        character: Some(test_character()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let relationships = runtime
        .get_service("relationships")
        .await
        .expect("relationships");
    let relationships = relationships
        .as_any()
        .downcast_ref::<RelationshipsService>()
        .expect("native relationships service");

    let mira_id = UUID::new_v4();
    let alex_id = UUID::new_v4();
    relationships.add_contact(mira_id.clone(), vec!["friend".to_string()], None);
    relationships.add_contact(alex_id.clone(), vec!["acquaintance".to_string()], None);

    let mut mira_fields = HashMap::new();
    mira_fields.insert("display_name".to_string(), json!("Mira"));
    relationships.update_contact(&mira_id, None, None, Some(mira_fields));

    let mut alex_fields = HashMap::new();
    alex_fields.insert("display_name".to_string(), json!("Alex"));
    relationships.update_contact(&alex_id, None, None, Some(alex_fields));

    let message = test_message("find Mira in relationships");
    let state = runtime.compose_state(&message).await?;
    let results = runtime.process_actions(&message, &state, None).await?;
    let search_result = results
        .iter()
        .find(|result| result.text.as_deref() == Some("Found 1 matching contacts."))
        .expect("search result");
    let contacts = search_result
        .data
        .as_ref()
        .and_then(|data| data.get("contacts"))
        .and_then(|value| value.as_array())
        .expect("contacts array");

    assert_eq!(contacts.len(), 1);
    assert!(contacts[0]
        .as_str()
        .is_some_and(|summary| summary.contains(mira_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn native_runtime_compose_state_continues_after_provider_failure() -> Result<()> {
    struct BrokenProvider;

    #[async_trait]
    impl ProviderHandler for BrokenProvider {
        fn definition(&self) -> ProviderDefinition {
            ProviderDefinition {
                name: "BROKEN_PROVIDER".to_string(),
                description: Some("A provider that throws".to_string()),
                dynamic: Some(false),
                position: Some(1),
                private: Some(false),
            }
        }

        async fn get(&self, _message: &Memory, _state: &State) -> Result<ProviderResult> {
            anyhow::bail!("rolodex provider exploded");
        }
    }

    struct HealthyProvider;

    #[async_trait]
    impl ProviderHandler for HealthyProvider {
        fn definition(&self) -> ProviderDefinition {
            ProviderDefinition {
                name: "HEALTHY_PROVIDER".to_string(),
                description: Some("A provider that succeeds".to_string()),
                dynamic: Some(false),
                position: Some(2),
                private: Some(false),
            }
        }

        async fn get(&self, _message: &Memory, _state: &State) -> Result<ProviderResult> {
            Ok(ProviderResult::with_text("Healthy provider context"))
        }
    }

    let runtime: Arc<AgentRuntime> = AgentRuntime::new(RuntimeOptions {
        character: Some(test_character()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let plugin = Plugin {
        definition: PluginDefinition {
            name: "provider-failure-test".to_string(),
            description: "Regression coverage for provider failures".to_string(),
            ..Default::default()
        },
        provider_handlers: vec![Arc::new(BrokenProvider), Arc::new(HealthyProvider)],
        ..Default::default()
    };
    runtime.register_plugin(plugin).await?;

    let state = runtime.compose_state(&test_message("hello")).await?;

    assert!(state.text.contains("Healthy provider context"));
    assert!(!state.text.contains("rolodex provider exploded"));

    Ok(())
}
