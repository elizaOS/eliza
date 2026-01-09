//! Integration tests for the elizaOS Bootstrap Plugin.
//!
//! These tests require the `integration-tests` feature and running services.

#![cfg(feature = "integration-tests")]

use elizaos_plugin_bootstrap::prelude::*;

/// Test that the plugin can be created and has all expected components.
#[test]
fn test_plugin_components() {
    let plugin = BootstrapPlugin::new();

    // Verify actions
    let expected_actions = [
        "REPLY",
        "IGNORE",
        "NONE",
        "CHOOSE_OPTION",
        "FOLLOW_ROOM",
        "UNFOLLOW_ROOM",
        "MUTE_ROOM",
        "UNMUTE_ROOM",
        "GENERATE_IMAGE",
        "UPDATE_ROLE",
        "UPDATE_SETTINGS",
        "SEND_MESSAGE",
        "UPDATE_ENTITY",
    ];

    for action_name in &expected_actions {
        assert!(
            plugin.get_action(action_name).is_some(),
            "Missing action: {}",
            action_name
        );
    }

    // Verify providers
    let expected_providers = [
        "CHARACTER",
        "CURRENT_TIME",
        "ENTITIES",
        "KNOWLEDGE",
        "RECENT_MESSAGES",
        "WORLD",
        "ACTION_STATE",
        "AGENT_SETTINGS",
        "FACTS",
    ];

    for provider_name in &expected_providers {
        assert!(
            plugin.get_provider(provider_name).is_some(),
            "Missing provider: {}",
            provider_name
        );
    }

    // Verify evaluators
    let expected_evaluators = ["GOAL", "REFLECTION"];

    for evaluator_name in &expected_evaluators {
        assert!(
            plugin.get_evaluator(evaluator_name).is_some(),
            "Missing evaluator: {}",
            evaluator_name
        );
    }
}

/// Test action similes work correctly.
#[test]
fn test_action_similes() {
    let plugin = BootstrapPlugin::new();

    // Test REPLY similes
    assert!(plugin.get_action("RESPOND").is_some());
    assert!(plugin.get_action("GREET").is_some());

    // Test IGNORE similes
    assert!(plugin.get_action("STOP_TALKING").is_some());

    // Test NONE similes
    assert!(plugin.get_action("NO_ACTION").is_some());
    assert!(plugin.get_action("PASS").is_some());
}

/// Test XML parsing utilities.
#[test]
fn test_xml_parsing() {
    use elizaos_plugin_bootstrap::xml::parse_key_value_xml;

    let xml = r#"
        <response>
            <thought>Testing the parser</thought>
            <text>Hello world</text>
            <value>42</value>
        </response>
    "#;

    let result = parse_key_value_xml(xml);
    assert!(result.is_some());

    let parsed = result.unwrap();
    assert_eq!(parsed.get("thought"), Some(&"Testing the parser".to_string()));
    assert_eq!(parsed.get("text"), Some(&"Hello world".to_string()));
    assert_eq!(parsed.get("value"), Some(&"42".to_string()));
}

/// Test action result creation.
#[test]
fn test_action_result() {
    let result = ActionResult::success("Test success")
        .with_value("key1", "value1")
        .with_data("data1", 42);

    assert!(result.success);
    assert_eq!(result.text, "Test success");
    assert!(result.values.contains_key("key1"));
    assert!(result.data.contains_key("data1"));
}

/// Test provider result creation.
#[test]
fn test_provider_result() {
    let result = ProviderResult::new("Test context")
        .with_value("key1", "value1")
        .with_data("data1", true);

    assert_eq!(result.text, "Test context");
    assert!(result.values.contains_key("key1"));
    assert!(result.data.contains_key("data1"));
}

/// Test evaluator result creation.
#[test]
fn test_evaluator_result() {
    let pass_result = EvaluatorResult::pass(85, "Good progress")
        .with_detail("detail1", "test");

    assert!(pass_result.passed);
    assert_eq!(pass_result.score, 85);
    assert_eq!(pass_result.reason, "Good progress");

    let fail_result = EvaluatorResult::fail(30, "Needs improvement");

    assert!(!fail_result.passed);
    assert_eq!(fail_result.score, 30);
}

