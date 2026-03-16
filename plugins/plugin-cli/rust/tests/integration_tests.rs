use elizaos_plugin_cli::{
    parse_duration, format_duration, format_bytes, truncate_string,
    parse_timeout_ms, format_cli_command,
    CliRegistry, CliCommand, CliArg, CliContext, ProgressReporter,
    DEFAULT_CLI_NAME, DEFAULT_CLI_VERSION, PLUGIN_NAME, PLUGIN_VERSION,
};
use pretty_assertions::assert_eq;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

#[test]
fn test_registry_register_and_lookup() {
    let mut reg = CliRegistry::new();
    let cmd = CliCommand::new("run", "Run the agent", "handle_run");
    reg.register_command(cmd);

    let found = reg.get_command("run");
    assert!(found.is_some());
    assert_eq!(found.unwrap().name, "run");
    assert_eq!(found.unwrap().description, "Run the agent");
}

#[test]
fn test_registry_has_command() {
    let mut reg = CliRegistry::new();
    assert!(!reg.has_command("run"));

    reg.register_command(CliCommand::new("run", "Run", "handle_run"));
    assert!(reg.has_command("run"));
    assert!(!reg.has_command("build"));
}

#[test]
fn test_registry_list_sorted_by_priority() {
    let mut reg = CliRegistry::new();
    reg.register_command(CliCommand::new("config", "Config", "handle_config").with_priority(50));
    reg.register_command(CliCommand::new("run", "Run", "handle_run").with_priority(10));
    reg.register_command(CliCommand::new("build", "Build", "handle_build").with_priority(30));

    let cmds = reg.list_commands();
    assert_eq!(cmds.len(), 3);
    assert_eq!(cmds[0].name, "run");    // priority 10
    assert_eq!(cmds[1].name, "build");  // priority 30
    assert_eq!(cmds[2].name, "config"); // priority 50
}

#[test]
fn test_registry_unregister() {
    let mut reg = CliRegistry::new();
    reg.register_command(CliCommand::new("run", "Run", "handle_run"));
    assert!(reg.has_command("run"));

    let removed = reg.unregister_command("run");
    assert!(removed.is_some());
    assert!(!reg.has_command("run"));
    assert_eq!(reg.len(), 0);
}

#[test]
fn test_registry_replace_existing() {
    let mut reg = CliRegistry::new();
    reg.register_command(CliCommand::new("run", "Old description", "handle_run_v1"));
    let old = reg.register_command(CliCommand::new("run", "New description", "handle_run_v2"));

    assert!(old.is_some());
    assert_eq!(old.unwrap().description, "Old description");
    assert_eq!(reg.get_command("run").unwrap().description, "New description");
}

#[test]
fn test_registry_find_by_alias() {
    let mut reg = CliRegistry::new();
    let cmd = CliCommand::new("run", "Run the agent", "handle_run")
        .with_alias("start")
        .with_alias("go");
    reg.register_command(cmd);

    assert!(reg.find_command("start").is_some());
    assert!(reg.find_command("go").is_some());
    assert!(reg.find_command("run").is_some());
    assert!(reg.find_command("stop").is_none());
}

#[test]
fn test_registry_command_names() {
    let mut reg = CliRegistry::new();
    reg.register_command(CliCommand::new("build", "Build", "h1"));
    reg.register_command(CliCommand::new("run", "Run", "h2"));
    reg.register_command(CliCommand::new("config", "Config", "h3"));

    let names = reg.command_names();
    assert_eq!(names, vec!["build", "config", "run"]); // sorted alphabetically
}

#[test]
fn test_registry_clear() {
    let mut reg = CliRegistry::new();
    reg.register_command(CliCommand::new("a", "A", "h1"));
    reg.register_command(CliCommand::new("b", "B", "h2"));
    assert_eq!(reg.len(), 2);

    reg.clear();
    assert!(reg.is_empty());
    assert_eq!(reg.len(), 0);
}

#[test]
fn test_command_with_args() {
    let cmd = CliCommand::new("deploy", "Deploy the app", "handle_deploy")
        .with_arg(CliArg::required("target", "Deployment target"))
        .with_arg(CliArg::optional("port", "Listen port", "3000"));

    assert_eq!(cmd.args.len(), 2);
    assert!(cmd.args[0].required);
    assert_eq!(cmd.args[0].name, "target");
    assert!(!cmd.args[1].required);
    assert_eq!(cmd.args[1].default_value.as_deref(), Some("3000"));
}

// ---------------------------------------------------------------------------
// Duration parsing tests
// ---------------------------------------------------------------------------

#[test]
fn test_parse_duration_seconds() {
    assert_eq!(parse_duration("1s"), Some(Duration::from_secs(1)));
    assert_eq!(parse_duration("90s"), Some(Duration::from_secs(90)));
    assert_eq!(parse_duration("0s"), Some(Duration::from_secs(0)));
}

#[test]
fn test_parse_duration_minutes() {
    assert_eq!(parse_duration("30m"), Some(Duration::from_secs(30 * 60)));
    assert_eq!(parse_duration("1min"), Some(Duration::from_secs(60)));
}

#[test]
fn test_parse_duration_hours() {
    assert_eq!(parse_duration("1h"), Some(Duration::from_secs(3600)));
    assert_eq!(parse_duration("2hr"), Some(Duration::from_secs(7200)));
}

#[test]
fn test_parse_duration_days() {
    assert_eq!(parse_duration("2d"), Some(Duration::from_secs(2 * 86400)));
    assert_eq!(parse_duration("1day"), Some(Duration::from_secs(86400)));
}

#[test]
fn test_parse_duration_compound() {
    // 1h30m = 90 minutes = 5400 seconds
    assert_eq!(parse_duration("1h30m"), Some(Duration::from_secs(5400)));
    // 2d12h = 2*86400 + 12*3600 = 216000 seconds
    assert_eq!(parse_duration("2d12h"), Some(Duration::from_secs(216000)));
}

#[test]
fn test_parse_duration_milliseconds() {
    assert_eq!(parse_duration("500ms"), Some(Duration::from_millis(500)));
    assert_eq!(parse_duration("1000"), Some(Duration::from_millis(1000)));
}

#[test]
fn test_parse_duration_invalid() {
    assert_eq!(parse_duration(""), None);
    assert_eq!(parse_duration("abc"), None);
    assert_eq!(parse_duration("1x"), None);
    assert_eq!(parse_duration("h1"), None);
}

#[test]
fn test_parse_duration_whitespace() {
    assert_eq!(parse_duration("  1h  "), Some(Duration::from_secs(3600)));
    assert_eq!(parse_duration(" 30m "), Some(Duration::from_secs(1800)));
}

// ---------------------------------------------------------------------------
// Format utilities tests
// ---------------------------------------------------------------------------

#[test]
fn test_format_duration_ranges() {
    assert_eq!(format_duration(Duration::from_millis(450)), "450ms");
    assert_eq!(format_duration(Duration::from_millis(1500)), "1.5s");
    assert_eq!(format_duration(Duration::from_secs(90)), "1.5m");
    assert_eq!(format_duration(Duration::from_secs(5400)), "1.5h");
    assert_eq!(format_duration(Duration::from_secs(172800)), "2.0d");
}

#[test]
fn test_format_bytes_various() {
    assert_eq!(format_bytes(0), "0 B");
    assert_eq!(format_bytes(512), "512 B");
    assert_eq!(format_bytes(1024), "1.0 KB");
    assert_eq!(format_bytes(1536), "1.5 KB");
    assert_eq!(format_bytes(1048576), "1.0 MB");
    assert_eq!(format_bytes(1073741824), "1.0 GB");
    assert_eq!(format_bytes(1099511627776), "1.0 TB");
}

#[test]
fn test_truncate_string() {
    assert_eq!(truncate_string("hello", 10), "hello");
    assert_eq!(truncate_string("hello world!", 8), "hello...");
    assert_eq!(truncate_string("ab", 2), "ab");
    assert_eq!(truncate_string("abcdef", 3), "...");
}

#[test]
fn test_parse_timeout_ms() {
    assert_eq!(parse_timeout_ms(Some("30s"), 5000), 30_000);
    assert_eq!(parse_timeout_ms(None, 5000), 5000);
    assert_eq!(parse_timeout_ms(Some("invalid!!"), 5000), 5000);
}

#[test]
fn test_format_cli_command() {
    assert_eq!(
        format_cli_command("run", None, None, None),
        "elizaos run"
    );
    assert_eq!(
        format_cli_command("run", Some("otto"), Some("dev"), Some("staging")),
        "otto --profile dev --env staging run"
    );
}

// ---------------------------------------------------------------------------
// Type tests
// ---------------------------------------------------------------------------

#[test]
fn test_cli_context_builder() {
    let ctx = CliContext::new("otto", "2.0.0", "Otto CLI")
        .with_workspace_dir("/home/user/project");

    assert_eq!(ctx.program_name, "otto");
    assert_eq!(ctx.version, "2.0.0");
    assert_eq!(ctx.workspace_dir.as_deref(), Some("/home/user/project"));
}

#[test]
fn test_progress_reporter() {
    let mut progress = ProgressReporter::new(10, "Starting...");
    assert_eq!(progress.fraction(), Some(0.0));
    assert!(!progress.is_complete());
    assert_eq!(progress.display(), "[0/10] Starting...");

    progress.advance("Step 1 done");
    assert_eq!(progress.current, 1);
    assert_eq!(progress.display(), "[1/10] Step 1 done");

    progress.set(10, "Done!");
    assert!(progress.is_complete());
    assert_eq!(progress.fraction(), Some(1.0));
}

#[test]
fn test_progress_reporter_unknown_total() {
    let mut progress = ProgressReporter::new(0, "Processing...");
    assert_eq!(progress.fraction(), None);
    assert!(!progress.is_complete());
    assert_eq!(progress.display(), "[0] Processing...");

    progress.advance("Item processed");
    assert_eq!(progress.display(), "[1] Item processed");
}

#[test]
fn test_command_matches() {
    let cmd = CliCommand::new("run", "Run", "handle_run")
        .with_aliases(vec!["start", "go"]);

    assert!(cmd.matches("run"));
    assert!(cmd.matches("start"));
    assert!(cmd.matches("go"));
    assert!(!cmd.matches("stop"));
}

#[test]
fn test_plugin_constants() {
    assert_eq!(PLUGIN_NAME, "cli");
    assert_eq!(PLUGIN_VERSION, "2.0.0");
    assert_eq!(DEFAULT_CLI_NAME, "elizaos");
    assert_eq!(DEFAULT_CLI_VERSION, "1.0.0");
}

#[test]
fn test_common_command_options_default() {
    let opts = elizaos_plugin_cli::CommonCommandOptions::default();
    assert!(!opts.json);
    assert!(!opts.verbose);
    assert!(!opts.quiet);
    assert!(!opts.force);
    assert!(!opts.dry_run);
}
