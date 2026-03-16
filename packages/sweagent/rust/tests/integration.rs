//! Integration tests for SWE-agent Rust implementation

use elizaos_sweagent::agent::models::{
    GenericApiModelConfig, GlobalStats, InstanceStats, InstantEmptySubmitModel, Model,
};
use elizaos_sweagent::agent::problem_statement::{
    EmptyProblemStatement, ProblemStatement, TextProblemStatement,
};
use elizaos_sweagent::environment::{DeploymentConfig, EnvironmentConfig, MockDeployment, SWEEnv};
use elizaos_sweagent::run::{RunBatchConfig, RunSingleConfig};
use elizaos_sweagent::tools::{ParseFunction, ThoughtActionParser, ToolConfig, ToolHandler};
use elizaos_sweagent::types::{Content, HistoryItem, Role};
use elizaos_sweagent::VERSION;
use std::sync::Arc;

#[test]
fn test_version() {
    assert_eq!(VERSION, "1.1.0");
}

#[test]
fn test_history_item_creation() {
    let item = HistoryItem::system("You are a helpful assistant");
    assert_eq!(item.role, Role::System);
    assert_eq!(item.content.as_str(), "You are a helpful assistant");

    let action = HistoryItem::action("Let me run ls", "ls -la");
    assert_eq!(action.role, Role::Assistant);
    assert_eq!(action.thought, Some("Let me run ls".to_string()));
    assert_eq!(action.action, Some("ls -la".to_string()));
}

#[test]
fn test_problem_statement() {
    let empty = EmptyProblemStatement::new();
    assert_eq!(empty.id(), "empty");
    assert!(empty.get_problem_statement().is_empty());

    let text = TextProblemStatement::new("Fix the bug in main.py", "bug-123");
    assert_eq!(text.id(), "bug-123");
    assert_eq!(text.get_problem_statement(), "Fix the bug in main.py");
}

#[tokio::test]
async fn test_mock_deployment() {
    use elizaos_sweagent::environment::Deployment;

    let mut deployment = MockDeployment::new()
        .with_file("/test.txt", "hello world")
        .with_command_output("echo hello", "hello\n");

    // Start deployment
    deployment.start().await.unwrap();
    assert!(deployment.is_running());

    // Execute command
    let output = deployment.execute("echo hello", None).await.unwrap();
    assert_eq!(output, "hello\n");

    // Read file
    let content = deployment.read_file("/test.txt").await.unwrap();
    assert_eq!(content, "hello world");

    // Stop deployment
    deployment.stop().await.unwrap();
    assert!(!deployment.is_running());
}

#[tokio::test]
async fn test_swe_env_creation() {
    let config = EnvironmentConfig {
        deployment: DeploymentConfig::Mock,
        name: "test-env".to_string(),
        ..Default::default()
    };

    let mut env = SWEEnv::new(config).unwrap();
    env.start().await.unwrap();

    assert!(env.is_running());
    assert_eq!(env.name, "test-env");

    env.stop().await.unwrap();
    assert!(!env.is_running());
}

#[tokio::test]
async fn test_instant_empty_submit_model() {
    let model = InstantEmptySubmitModel::new();
    let history = vec![];

    let output1 = model.query(&history).await.unwrap();
    assert!(output1.message.contains("reproduce"));

    let output2 = model.query(&history).await.unwrap();
    assert!(output2.message.contains("submit"));
}

#[test]
fn test_instance_stats() {
    let a = InstanceStats {
        instance_cost: 1.0,
        tokens_sent: 100,
        tokens_received: 50,
        api_calls: 1,
    };
    let b = InstanceStats {
        instance_cost: 2.0,
        tokens_sent: 200,
        tokens_received: 100,
        api_calls: 2,
    };

    let combined = a.add(&b);
    assert_eq!(combined.instance_cost, 3.0);
    assert_eq!(combined.tokens_sent, 300);
    assert_eq!(combined.tokens_received, 150);
    assert_eq!(combined.api_calls, 3);
}

#[test]
fn test_thought_action_parser() {
    let parser = ThoughtActionParser::new();

    let output = "Let me check the file.\n\n```\ncat file.txt\n```";
    let (thought, action) = parser.parse(output, &[], true).unwrap();

    assert_eq!(thought, "Let me check the file.");
    assert_eq!(action, "cat file.txt");
}

#[test]
fn test_thought_action_parser_with_language() {
    let parser = ThoughtActionParser::new();

    let output = "Running a bash command:\n\n```bash\nls -la\n```";
    let (_, action) = parser.parse(output, &[], true).unwrap();

    assert_eq!(action, "ls -la");
}

#[test]
fn test_tool_handler_creation() {
    let config = ToolConfig::default();
    let handler = ToolHandler::new(config).unwrap();

    assert!(!handler.should_block_action("ls -la"));
}

#[test]
fn test_tool_filter() {
    use elizaos_sweagent::tools::ToolFilterConfig;

    let config = ToolConfig {
        filter: Some(ToolFilterConfig {
            blocklist: vec!["rm -rf".to_string()],
            blocklist_standalone: vec!["exit".to_string()],
            ..Default::default()
        }),
        ..Default::default()
    };

    let handler = ToolHandler::new(config).unwrap();

    assert!(handler.should_block_action("rm -rf /"));
    assert!(!handler.should_block_action("rm file.txt"));
    assert!(!handler.should_block_action("ls -la"));
}

#[test]
fn test_run_single_config_default() {
    let config = RunSingleConfig::default();
    assert_eq!(config.output_dir, "./trajectories");
}

#[test]
fn test_run_batch_config_default() {
    let config = RunBatchConfig::default();
    assert_eq!(config.num_workers, 1);
    assert!(!config.redo_existing);
}

#[test]
fn test_global_stats() {
    let stats = GlobalStats::default();

    stats.add_cost(1.5);
    assert!((stats.get_total_cost() - 1.5).abs() < 0.0001);

    stats.add_cost(2.5);
    assert!((stats.get_total_cost() - 4.0).abs() < 0.0001);
}

#[test]
fn test_content_types() {
    let text = Content::Text("hello".to_string());
    assert_eq!(text.as_str(), "hello");

    let structured = Content::Structured(vec![
        elizaos_sweagent::types::ContentPart::Text {
            text: "part1".to_string(),
        },
        elizaos_sweagent::types::ContentPart::Text {
            text: "part2".to_string(),
        },
    ]);
    assert_eq!(structured.as_str(), "part1\npart2");
}

#[tokio::test]
async fn test_run_single_creation() {
    let config = RunSingleConfig {
        env: EnvironmentConfig {
            deployment: DeploymentConfig::Mock,
            ..Default::default()
        },
        ..Default::default()
    };

    let runner = elizaos_sweagent::run::RunSingle::from_config(config);
    assert!(runner.is_ok());
}
