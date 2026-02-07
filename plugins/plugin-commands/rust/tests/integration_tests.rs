use elizaos_plugin_commands::{
    default_registry, extract_command_args, is_command, normalize_command_name, parse_command,
    Action, CommandCategory, CommandDefinition, CommandRegistry,
};
use elizaos_plugin_commands::actions::{
    CommandsListAction, HelpCommandAction, ModelsCommandAction, StatusCommandAction,
    StopCommandAction,
};
use elizaos_plugin_commands::providers::CommandRegistryProvider;
use elizaos_plugin_commands::Provider;
use serde_json::json;

// ── Parser tests ────────────────────────────────────────────────────────

#[test]
fn test_is_command_slash_prefix() {
    assert!(is_command("/help"));
    assert!(is_command("/status"));
    assert!(is_command("/stop now"));
    assert!(is_command("/models"));
    assert!(is_command("/commands"));
}

#[test]
fn test_is_command_bang_prefix() {
    assert!(is_command("!help"));
    assert!(is_command("!stop"));
    assert!(is_command("!bash ls -la"));
}

#[test]
fn test_is_command_negative_cases() {
    assert!(!is_command("hello world"));
    assert!(!is_command(""));
    assert!(!is_command("   "));
    assert!(!is_command("just some text"));
    assert!(!is_command("123"));
    assert!(!is_command("/ no_good"));
}

#[test]
fn test_is_command_with_leading_whitespace() {
    assert!(is_command("  /help"));
    assert!(is_command("\t/status"));
}

#[test]
fn test_parse_command_simple() {
    let parsed = parse_command("/help").unwrap();
    assert_eq!(parsed.name, "help");
    assert!(parsed.args.is_empty());
    assert_eq!(parsed.raw_text, "/help");
}

#[test]
fn test_parse_command_with_args() {
    let parsed = parse_command("/model gpt-4 fast").unwrap();
    assert_eq!(parsed.name, "model");
    assert_eq!(parsed.args, vec!["gpt-4", "fast"]);
}

#[test]
fn test_parse_command_colon_separator() {
    let parsed = parse_command("/think:high").unwrap();
    assert_eq!(parsed.name, "think");
    assert_eq!(parsed.args, vec!["high"]);
}

#[test]
fn test_parse_command_bang_prefix() {
    let parsed = parse_command("!stop").unwrap();
    assert_eq!(parsed.name, "stop");
    assert!(parsed.args.is_empty());
}

#[test]
fn test_parse_command_returns_none_for_text() {
    assert!(parse_command("hello").is_none());
    assert!(parse_command("").is_none());
    assert!(parse_command("   ").is_none());
}

#[test]
fn test_parse_command_quoted_args() {
    let parsed = parse_command(r#"/bash "echo hello world" --verbose"#).unwrap();
    assert_eq!(parsed.name, "bash");
    assert_eq!(parsed.args, vec!["echo hello world", "--verbose"]);
}

#[test]
fn test_normalize_command_name_cases() {
    assert_eq!(normalize_command_name("Help"), "help");
    assert_eq!(normalize_command_name("MY-CMD"), "my_cmd");
    assert_eq!(normalize_command_name("  Status  "), "status");
    assert_eq!(normalize_command_name("STOP"), "stop");
    assert_eq!(normalize_command_name("commands-list"), "commands_list");
}

#[test]
fn test_extract_command_args_empty() {
    let args = extract_command_args("");
    assert!(args.is_empty());
    let args2 = extract_command_args("   ");
    assert!(args2.is_empty());
}

#[test]
fn test_extract_command_args_simple() {
    let args = extract_command_args("arg1 arg2 arg3");
    assert_eq!(args, vec!["arg1", "arg2", "arg3"]);
}

#[test]
fn test_extract_command_args_quoted() {
    let args = extract_command_args(r#""hello world" simple 'another quoted'"#);
    assert_eq!(args, vec!["hello world", "simple", "another quoted"]);
}

// ── Registry tests ──────────────────────────────────────────────────────

#[test]
fn test_registry_new_is_empty() {
    let reg = CommandRegistry::new();
    assert!(reg.is_empty());
    assert_eq!(reg.len(), 0);
}

#[test]
fn test_registry_register_and_lookup() {
    let mut reg = CommandRegistry::new();
    reg.register(CommandDefinition::new("ping", "Pong!"));
    assert_eq!(reg.len(), 1);
    let cmd = reg.lookup("ping").unwrap();
    assert_eq!(cmd.name, "ping");
    assert_eq!(cmd.description, "Pong!");
}

#[test]
fn test_registry_lookup_by_alias() {
    let mut reg = CommandRegistry::new();
    reg.register(
        CommandDefinition::new("help", "Show help").with_aliases(vec!["h", "?"]),
    );
    assert!(reg.lookup("help").is_some());
    assert!(reg.lookup("h").is_some());
    assert!(reg.lookup("?").is_some());
    assert_eq!(reg.lookup("h").unwrap().name, "help");
}

#[test]
fn test_registry_lookup_case_insensitive() {
    let mut reg = CommandRegistry::new();
    reg.register(CommandDefinition::new("help", "Show help"));
    assert!(reg.lookup("HELP").is_some());
    assert!(reg.lookup("Help").is_some());
}

#[test]
fn test_registry_lookup_nonexistent() {
    let reg = CommandRegistry::new();
    assert!(reg.lookup("nope").is_none());
}

#[test]
fn test_registry_unregister() {
    let mut reg = CommandRegistry::new();
    reg.register(CommandDefinition::new("temp", "Temporary"));
    assert!(reg.unregister("temp"));
    assert!(reg.lookup("temp").is_none());
    assert!(!reg.unregister("temp")); // already removed
}

#[test]
fn test_registry_unregister_clears_aliases() {
    let mut reg = CommandRegistry::new();
    reg.register(
        CommandDefinition::new("test", "Test cmd").with_aliases(vec!["t"]),
    );
    assert!(reg.lookup("t").is_some());
    reg.unregister("test");
    assert!(reg.lookup("t").is_none());
}

#[test]
fn test_registry_replace_existing() {
    let mut reg = CommandRegistry::new();
    reg.register(CommandDefinition::new("cmd", "Version 1"));
    reg.register(CommandDefinition::new("cmd", "Version 2"));
    assert_eq!(reg.len(), 1);
    assert_eq!(reg.lookup("cmd").unwrap().description, "Version 2");
}

#[test]
fn test_registry_list_all() {
    let mut reg = CommandRegistry::new();
    reg.register(CommandDefinition::new("a", "A"));
    reg.register(CommandDefinition::new("b", "B"));
    reg.register(CommandDefinition::new("c", "C"));
    assert_eq!(reg.list_all().len(), 3);
}

#[test]
fn test_registry_list_by_category() {
    let mut reg = CommandRegistry::new();
    reg.register(
        CommandDefinition::new("a", "A").with_category(CommandCategory::General),
    );
    reg.register(
        CommandDefinition::new("b", "B").with_category(CommandCategory::Admin),
    );
    reg.register(
        CommandDefinition::new("c", "C").with_category(CommandCategory::General),
    );

    let general = reg.list_by_category(CommandCategory::General);
    assert_eq!(general.len(), 2);
    let admin = reg.list_by_category(CommandCategory::Admin);
    assert_eq!(admin.len(), 1);
    let debug = reg.list_by_category(CommandCategory::Debug);
    assert!(debug.is_empty());
}

#[test]
fn test_registry_help_text() {
    let reg = default_registry();
    let help = reg.get_help_text();
    assert!(help.contains("**Available Commands:**"));
    assert!(help.contains("/help"));
    assert!(help.contains("/status"));
    assert!(help.contains("/stop"));
    assert!(help.contains("/models"));
    assert!(help.contains("/commands"));
}

#[test]
fn test_registry_help_text_hides_hidden_commands() {
    let mut reg = CommandRegistry::new();
    reg.register(CommandDefinition::new("visible", "I'm visible"));
    reg.register(
        CommandDefinition::new("secret", "I'm hidden").with_hidden(true),
    );

    let help = reg.get_help_text();
    assert!(help.contains("visible"));
    assert!(!help.contains("secret"));
}

#[test]
fn test_default_registry_has_five_commands() {
    let reg = default_registry();
    assert_eq!(reg.len(), 5);
    assert!(reg.lookup("help").is_some());
    assert!(reg.lookup("status").is_some());
    assert!(reg.lookup("stop").is_some());
    assert!(reg.lookup("models").is_some());
    assert!(reg.lookup("commands").is_some());
    // aliases
    assert!(reg.lookup("h").is_some());
    assert!(reg.lookup("s").is_some());
    assert!(reg.lookup("abort").is_some());
    assert!(reg.lookup("cancel").is_some());
    assert!(reg.lookup("cmds").is_some());
}

// ── Action handler tests ────────────────────────────────────────────────

fn make_message(text: &str) -> serde_json::Value {
    json!({
        "content": { "text": text },
        "room_id": "room-123",
        "agent_id": "agent-456",
        "entity_id": "user-789",
    })
}

#[tokio::test]
async fn test_help_action_validate() {
    let action = HelpCommandAction;
    let state = json!({});
    assert!(action.validate(&make_message("/help"), &state).await);
    assert!(action.validate(&make_message("/h"), &state).await);
    assert!(!action.validate(&make_message("/status"), &state).await);
    assert!(!action.validate(&make_message("help me"), &state).await);
}

#[tokio::test]
async fn test_help_action_handler() {
    let action = HelpCommandAction;
    let reg = default_registry();
    let result = action
        .handler(&make_message("/help"), &json!({}), Some(&reg))
        .await;
    assert!(result.success);
    assert!(result.text.contains("**Available Commands:**"));
    assert!(result.text.contains("/help"));
}

#[tokio::test]
async fn test_status_action_validate() {
    let action = StatusCommandAction;
    let state = json!({});
    assert!(action.validate(&make_message("/status"), &state).await);
    assert!(action.validate(&make_message("/s"), &state).await);
    assert!(!action.validate(&make_message("/help"), &state).await);
    assert!(!action.validate(&make_message("status check"), &state).await);
}

#[tokio::test]
async fn test_status_action_handler() {
    let action = StatusCommandAction;
    let result = action
        .handler(&make_message("/status"), &json!({}), None)
        .await;
    assert!(result.success);
    assert!(result.text.contains("**Session Status:**"));
    assert!(result.text.contains("agent-456"));
    assert!(result.text.contains("room-123"));
}

#[tokio::test]
async fn test_stop_action_validate() {
    let action = StopCommandAction;
    let state = json!({});
    assert!(action.validate(&make_message("/stop"), &state).await);
    assert!(action.validate(&make_message("/abort"), &state).await);
    assert!(action.validate(&make_message("/cancel"), &state).await);
    assert!(!action.validate(&make_message("please stop"), &state).await);
}

#[tokio::test]
async fn test_stop_action_handler() {
    let action = StopCommandAction;
    let result = action
        .handler(&make_message("/stop"), &json!({}), None)
        .await;
    assert!(result.success);
    assert!(result.text.contains("Stop requested"));
}

#[tokio::test]
async fn test_models_action_validate() {
    let action = ModelsCommandAction;
    let state = json!({});
    assert!(action.validate(&make_message("/models"), &state).await);
    assert!(!action.validate(&make_message("/help"), &state).await);
    assert!(!action.validate(&make_message("show models"), &state).await);
}

#[tokio::test]
async fn test_models_action_handler_no_models() {
    let action = ModelsCommandAction;
    let result = action
        .handler(&make_message("/models"), &json!({}), None)
        .await;
    assert!(result.success);
    assert!(result.text.contains("**Available Models:**"));
    assert!(result.text.contains("No model information available"));
}

#[tokio::test]
async fn test_models_action_handler_with_models() {
    let action = ModelsCommandAction;
    let state = json!({
        "registered_model_types": ["text_large", "text_small"],
        "model_provider": "openai",
        "model_name": "gpt-4",
    });
    let result = action
        .handler(&make_message("/models"), &state, None)
        .await;
    assert!(result.success);
    assert!(result.text.contains("Text (Large)"));
    assert!(result.text.contains("Text (Small)"));
    assert!(result.text.contains("Provider: openai"));
    assert!(result.text.contains("Model: gpt-4"));
}

#[tokio::test]
async fn test_commands_list_action_validate() {
    let action = CommandsListAction;
    let state = json!({});
    assert!(action.validate(&make_message("/commands"), &state).await);
    assert!(action.validate(&make_message("/cmds"), &state).await);
    assert!(!action.validate(&make_message("/help"), &state).await);
    assert!(!action.validate(&make_message("list commands"), &state).await);
}

#[tokio::test]
async fn test_commands_list_action_handler() {
    let action = CommandsListAction;
    let reg = default_registry();
    let result = action
        .handler(&make_message("/commands"), &json!({}), Some(&reg))
        .await;
    assert!(result.success);
    assert!(result.text.contains("**Commands (5):**"));
    assert!(result.text.contains("**help**"));
    assert!(result.text.contains("**status**"));
    assert!(result.text.contains("**stop**"));
}

#[tokio::test]
async fn test_help_action_without_registry() {
    let action = HelpCommandAction;
    let result = action
        .handler(&make_message("/help"), &json!({}), None)
        .await;
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[tokio::test]
async fn test_commands_list_action_without_registry() {
    let action = CommandsListAction;
    let result = action
        .handler(&make_message("/commands"), &json!({}), None)
        .await;
    assert!(!result.success);
    assert!(result.error.is_some());
}

// ── Provider tests ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_provider_with_command_message() {
    let provider = CommandRegistryProvider;
    let reg = default_registry();
    let result = provider
        .get(&make_message("/help"), &json!({}), Some(&reg))
        .await;
    assert!(result.text.contains("slash command"));
    assert!(result.text.contains("/help"));
    assert_eq!(result.values["isCommand"], true);
}

#[tokio::test]
async fn test_provider_with_normal_message() {
    let provider = CommandRegistryProvider;
    let reg = default_registry();
    let result = provider
        .get(&make_message("hello there"), &json!({}), Some(&reg))
        .await;
    assert!(result.text.is_empty());
    assert_eq!(result.values["isCommand"], false);
    assert_eq!(result.values["commandCount"], 5);
}

// ── Action metadata tests ───────────────────────────────────────────────

#[test]
fn test_action_names() {
    assert_eq!(HelpCommandAction.name(), "HELP_COMMAND");
    assert_eq!(StatusCommandAction.name(), "STATUS_COMMAND");
    assert_eq!(StopCommandAction.name(), "STOP_COMMAND");
    assert_eq!(ModelsCommandAction.name(), "MODELS_COMMAND");
    assert_eq!(CommandsListAction.name(), "COMMANDS_LIST_COMMAND");
}

#[test]
fn test_action_similes_are_slash_only() {
    let actions: Vec<Box<dyn Action>> = vec![
        Box::new(HelpCommandAction),
        Box::new(StatusCommandAction),
        Box::new(StopCommandAction),
        Box::new(ModelsCommandAction),
        Box::new(CommandsListAction),
    ];
    for action in &actions {
        for simile in action.similes() {
            assert!(
                simile.starts_with('/'),
                "Simile '{}' for action '{}' should start with /",
                simile,
                action.name()
            );
        }
    }
}

#[test]
fn test_action_examples_not_empty() {
    let actions: Vec<Box<dyn Action>> = vec![
        Box::new(HelpCommandAction),
        Box::new(StatusCommandAction),
        Box::new(StopCommandAction),
        Box::new(ModelsCommandAction),
        Box::new(CommandsListAction),
    ];
    for action in &actions {
        assert!(
            !action.examples().is_empty(),
            "Action '{}' should have at least one example",
            action.name()
        );
    }
}

#[test]
fn test_plugin_constants() {
    assert_eq!(elizaos_plugin_commands::PLUGIN_NAME, "commands");
    assert!(!elizaos_plugin_commands::PLUGIN_DESCRIPTION.is_empty());
    assert!(!elizaos_plugin_commands::PLUGIN_VERSION.is_empty());
}
