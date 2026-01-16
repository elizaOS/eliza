use anyhow::Result;
use elizaos::runtime::RuntimeOptions;
use elizaos::types::agent::{Bio, Character};
use elizaos::AgentRuntime;

#[tokio::test]
async fn advanced_planning_registers_actions_and_provider_when_enabled() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "AdvPlanningPluginOn".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_planning: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    // Service is registered
    assert!(runtime.get_service("planning").await.is_some());

    // Actions from the built-in plugin are registered
    let defs = runtime.list_action_definitions().await;
    let names: Vec<String> = defs.into_iter().map(|d| d.name).collect();
    assert!(names.iter().any(|n| n == "ANALYZE_INPUT"));
    assert!(names.iter().any(|n| n == "PROCESS_ANALYSIS"));
    assert!(names.iter().any(|n| n == "EXECUTE_FINAL"));
    assert!(names.iter().any(|n| n == "CREATE_PLAN"));

    // Provider is registered (indirectly verified by state composition including its text)
    let msg = elizaos::Memory::message(
        elizaos::UUID::new_v4(),
        elizaos::UUID::new_v4(),
        "plan this",
    );
    let state = runtime.compose_state(&msg).await?;
    // Provider outputs "Message classified as:" text
    assert!(state.text.contains("Message classified as:"));

    Ok(())
}
