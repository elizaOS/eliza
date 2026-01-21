use anyhow::Result;
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::types::agent::Character;

fn basic_character() -> Character {
    Character {
        name: "TestAgent".to_string(),
        bio: elizaos::types::agent::Bio::Single("test".to_string()),
        ..Default::default()
    }
}

#[tokio::test]
async fn bootstrap_registers_basic_actions_and_providers_by_default() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(basic_character()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let actions = runtime
        .list_action_definitions()
        .await
        .into_iter()
        .map(|d| d.name)
        .collect::<Vec<_>>();
    assert!(actions.contains(&"REPLY".to_string()));
    assert!(actions.contains(&"IGNORE".to_string()));
    assert!(actions.contains(&"NONE".to_string()));

    let providers = runtime
        .list_provider_definitions()
        .await
        .into_iter()
        .map(|d| d.name)
        .collect::<Vec<_>>();
    assert!(providers.contains(&"ACTIONS".to_string()));
    assert!(providers.contains(&"PROVIDERS".to_string()));
    assert!(providers.contains(&"EVALUATORS".to_string()));
    assert!(providers.contains(&"RECENT_MESSAGES".to_string()));
    assert!(providers.contains(&"CHARACTER".to_string()));

    Ok(())
}

#[tokio::test]
async fn bootstrap_can_disable_basic_capabilities_via_constructor_flag() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(basic_character()),
        disable_basic_capabilities: Some(true),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let actions = runtime.list_action_definitions().await;
    assert!(actions.is_empty());

    let providers = runtime.list_provider_definitions().await;
    assert!(providers.is_empty());

    Ok(())
}

#[tokio::test]
async fn bootstrap_skips_character_provider_for_anonymous_runtime() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: None,
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let providers = runtime
        .list_provider_definitions()
        .await
        .into_iter()
        .map(|d| d.name)
        .collect::<Vec<_>>();
    assert!(!providers.contains(&"CHARACTER".to_string()));
    Ok(())
}
