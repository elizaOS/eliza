//! Integration tests for ELIZA Classic Plugin.

use elizaos_plugin_eliza_classic::{reflect, ElizaClassicPlugin};

#[test]
fn test_plugin_greeting() {
    let plugin = ElizaClassicPlugin::new();
    let greeting = plugin.get_greeting();
    assert!(greeting.contains("ELIZA"));
}

#[test]
fn test_plugin_hello() {
    let plugin = ElizaClassicPlugin::new();
    let response = plugin.generate_response("hello");
    assert!(!response.is_empty());
}

#[test]
fn test_plugin_sad() {
    let plugin = ElizaClassicPlugin::new();
    let response = plugin.generate_response("I am sad today");
    assert!(!response.is_empty());
}

#[test]
fn test_plugin_family() {
    let plugin = ElizaClassicPlugin::new();
    let response = plugin.generate_response("my mother is very kind");
    assert!(!response.is_empty());
}

#[test]
fn test_plugin_computer() {
    let plugin = ElizaClassicPlugin::new();
    let response = plugin.generate_response("I think about computers");
    assert!(!response.is_empty());
}

#[test]
fn test_pronoun_reflection() {
    assert_eq!(reflect("i am happy"), "you are happy");
    assert_eq!(reflect("my car is fast"), "your car is fast");
}

#[test]
fn test_empty_input() {
    let plugin = ElizaClassicPlugin::new();
    let response = plugin.generate_response("");
    assert_eq!(response, "I didn't catch that. Could you please repeat?");
}

#[test]
fn test_reset_history() {
    let plugin = ElizaClassicPlugin::new();
    plugin.generate_response("hello");
    plugin.generate_response("how are you");
    plugin.reset_history();
    // Should still work after reset
    let response = plugin.generate_response("hello");
    assert!(!response.is_empty());
}





