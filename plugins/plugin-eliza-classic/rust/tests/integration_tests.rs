use elizaos_plugin_eliza_classic::{reflect, ElizaClassicPlugin};

#[test]
fn test_plugin_greeting() {
    let plugin = ElizaClassicPlugin::new();
    let greeting = plugin.get_greeting();
    assert!(greeting.to_lowercase().contains("problem"));
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
    assert_eq!(response, "Tell me more about your family");
}

#[test]
fn test_plugin_computer() {
    let plugin = ElizaClassicPlugin::new();
    let response = plugin.generate_response("computer");
    assert_eq!(response, "Do computers worry you?");
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
    assert!(!response.is_empty());
}

#[test]
fn test_reset_history() {
    let plugin = ElizaClassicPlugin::new();
    plugin.generate_response("hello");
    plugin.generate_response("how are you");
    plugin.reset_history();
    let response = plugin.generate_response("hello");
    assert!(!response.is_empty());
}

#[test]
fn test_golden_transcript_deterministic() {
    let plugin = ElizaClassicPlugin::new();
    let transcript = vec![
        ("hello", "How do you do? Please state your problem"),
        ("computer", "Do computers worry you?"),
        ("computer", "Why do you mention computers?"),
        (
            "computer",
            "What do you think machines have to do with your problem?",
        ),
        ("my mother is kind", "Tell me more about your family"),
        ("xyzzy", "I am not sure I understand you fully"),
    ];
    for (input, expected) in transcript {
        let got = plugin.generate_response(input);
        assert_eq!(got, expected);
    }
}

#[test]
fn test_pre_rules_work() {
    // YOU'RE triggers PRE rewrite then redirects to YOU.
    let plugin = ElizaClassicPlugin::new();
    let got = plugin.generate_response("you're sad");
    assert_eq!(got, "What makes you think I am sad?");
}

#[test]
fn test_memory_recall_on_limit_4() {
    let plugin = ElizaClassicPlugin::new();
    // record a memory via "my"
    plugin.generate_response("my car is broken");
    // advance LIMIT to 4 with no keyword match to trigger memory recall
    plugin.generate_response("xyzzy"); // limit=3
    let recalled = plugin.generate_response("xyzzy"); // limit=4
    let possible = [
        "Lets discuss further why your car is broken",
        "Earlier you said your car is broken",
        "But your car is broken",
        "Does that have anything to do with the fact that your car is broken?",
    ];
    assert!(
        possible.contains(&recalled.as_str()),
        "unexpected memory: {recalled}"
    );
}
