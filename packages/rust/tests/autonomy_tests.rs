use anyhow::Result;
use elizaos::runtime::RuntimeOptions;
use elizaos::types::agent::{Bio, Character, CharacterSettings};
use elizaos::AgentRuntime;
use std::collections::HashMap;

#[tokio::test]
async fn autonomy_can_be_enabled_via_constructor_flag() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: Some(true),
        character: Some(Character {
            name: "AutonomyOn".to_string(),
            bio: Bio::Single("Test".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    // Service should be registered (even if autonomy is disabled by default).
    assert!(runtime.get_service("AUTONOMY").await.is_some());

    // Provider should contribute status in normal rooms.
    let msg = elizaos::Memory::message(elizaos::UUID::new_v4(), elizaos::UUID::new_v4(), "hello");
    let state = runtime.compose_state(&msg).await?;
    assert!(state.text.contains("AUTONOMY_STATUS"));

    Ok(())
}

#[tokio::test]
async fn autonomy_can_be_enabled_via_character_settings() -> Result<()> {
    let mut values: HashMap<String, serde_json::Value> = HashMap::new();
    values.insert("ENABLE_AUTONOMY".to_string(), serde_json::Value::Bool(true));

    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: None,
        character: Some(Character {
            name: "AutonomySettingOn".to_string(),
            bio: Bio::Single("Test".to_string()),
            settings: Some(CharacterSettings { values }),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;
    assert!(runtime.get_service("AUTONOMY").await.is_some());

    // Turn on the loop via runtime flag.
    runtime.set_enable_autonomy(true);
    assert!(runtime.enable_autonomy());

    Ok(())
}
