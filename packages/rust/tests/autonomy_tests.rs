//! Tests for the Autonomy module
//!
//! Tests the autonomous operation capabilities including:
//! - AutonomyService lifecycle and enable/disable
//! - Service status and configuration
//! - Mode switching (continuous vs task)
//! - Interval configuration
//! - Provider behavior

use anyhow::Result;
use elizaos::autonomy::{autonomy_routes, AUTONOMY_SERVICE_TYPE};
use elizaos::runtime::RuntimeOptions;
use elizaos::types::agent::{Bio, Character, CharacterSettings};
use elizaos::AgentRuntime;
use std::collections::HashMap;

// ============================================================================
// Service Registration Tests
// ============================================================================

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

    // Service should be registered
    assert!(runtime.get_service("AUTONOMY").await.is_some());
    assert!(runtime.get_service(AUTONOMY_SERVICE_TYPE).await.is_some());

    // Provider should contribute status in normal rooms
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

    // Turn on the loop via runtime flag
    runtime.set_enable_autonomy(true);
    assert!(runtime.enable_autonomy());

    Ok(())
}

#[tokio::test]
async fn autonomy_service_type_is_correct() -> Result<()> {
    assert_eq!(AUTONOMY_SERVICE_TYPE, "AUTONOMY");
    Ok(())
}

// ============================================================================
// Enable/Disable Tests
// ============================================================================

#[tokio::test]
async fn autonomy_enable_disable_works() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: Some(true),
        character: Some(Character {
            name: "AutonomyToggle".to_string(),
            bio: Bio::Single("Test".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    // Initially enabled
    assert!(runtime.enable_autonomy());

    // Disable
    runtime.set_enable_autonomy(false);
    assert!(!runtime.enable_autonomy());

    // Re-enable
    runtime.set_enable_autonomy(true);
    assert!(runtime.enable_autonomy());

    Ok(())
}

// ============================================================================
// Routes Tests
// ============================================================================

#[test]
fn autonomy_routes_are_defined() {
    let routes = autonomy_routes();

    // Should have 5 routes
    assert_eq!(routes.len(), 5);

    // Check paths exist
    let paths: Vec<&str> = routes.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.contains(&"/autonomy/status"));
    assert!(paths.contains(&"/autonomy/enable"));
    assert!(paths.contains(&"/autonomy/disable"));
    assert!(paths.contains(&"/autonomy/toggle"));
    assert!(paths.contains(&"/autonomy/interval"));
}

#[test]
fn autonomy_routes_have_correct_methods() {
    use elizaos::types::plugin::HttpMethod;

    let routes = autonomy_routes();

    // Find status route - should be GET
    let status_route = routes.iter().find(|r| r.path == "/autonomy/status");
    assert!(status_route.is_some());
    assert!(matches!(status_route.unwrap().method, HttpMethod::Get));

    // Find enable route - should be POST
    let enable_route = routes.iter().find(|r| r.path == "/autonomy/enable");
    assert!(enable_route.is_some());
    assert!(matches!(enable_route.unwrap().method, HttpMethod::Post));
}

// ============================================================================
// Mode Configuration Tests
// ============================================================================

#[tokio::test]
async fn autonomy_mode_defaults_to_continuous() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: Some(true),
        character: Some(Character {
            name: "AutonomyModeDefault".to_string(),
            bio: Bio::Single("Test".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    // No AUTONOMY_MODE setting means continuous mode (default)
    let mode = runtime.get_setting("AUTONOMY_MODE").await;
    assert!(mode.is_none()); // No explicit setting = continuous default

    Ok(())
}

#[tokio::test]
async fn autonomy_mode_can_be_set_to_task() -> Result<()> {
    let mut values: HashMap<String, serde_json::Value> = HashMap::new();
    values.insert("ENABLE_AUTONOMY".to_string(), serde_json::Value::Bool(true));
    values.insert(
        "AUTONOMY_MODE".to_string(),
        serde_json::Value::String("task".to_string()),
    );

    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: Some(true),
        character: Some(Character {
            name: "AutonomyTaskMode".to_string(),
            bio: Bio::Single("Test".to_string()),
            settings: Some(CharacterSettings { values }),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    // Check mode setting
    let mode = runtime.get_setting("AUTONOMY_MODE").await;
    assert!(mode.is_some());

    Ok(())
}

// ============================================================================
// Provider Behavior Tests
// ============================================================================

#[tokio::test]
async fn autonomy_status_provider_shows_running_state() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: Some(true),
        character: Some(Character {
            name: "AutonomyProviderTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    // Compose state in a normal room (not the autonomous room)
    let msg = elizaos::Memory::message(elizaos::UUID::new_v4(), elizaos::UUID::new_v4(), "hello");
    let state = runtime.compose_state(&msg).await?;

    // Should contain autonomy status
    assert!(state.text.contains("AUTONOMY_STATUS"));

    Ok(())
}

// ============================================================================
// Integration Tests
// ============================================================================

#[tokio::test]
async fn autonomy_service_exports_are_available() -> Result<()> {
    // Test that all public exports from autonomy module are accessible
    let _ = AUTONOMY_SERVICE_TYPE;
    let _ = autonomy_routes();

    // AutonomyService should be importable (tested via runtime registration)
    let runtime = AgentRuntime::new(RuntimeOptions {
        enable_autonomy: Some(true),
        character: Some(Character {
            name: "AutonomyExportTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;
    assert!(runtime.get_service(AUTONOMY_SERVICE_TYPE).await.is_some());
    Ok(())
}
