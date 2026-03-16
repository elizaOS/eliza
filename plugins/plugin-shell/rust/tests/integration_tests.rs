use elizaos_plugin_shell::{
    is_forbidden_command, is_safe_command, validate_path, ShellConfig, ShellService,
};
use std::path::PathBuf;
use tempfile::tempdir;

#[test]
fn test_path_validation() {
    let allowed = PathBuf::from("/home/user/allowed");
    let current = PathBuf::from("/home/user/allowed");

    let result = validate_path("subfolder", &allowed, &current);
    assert!(result.is_some());

    let result = validate_path("../../../etc", &allowed, &current);
    assert!(result.is_none());
}

#[test]
fn test_safe_command_detection() {
    assert!(is_safe_command("ls -la"));
    assert!(is_safe_command("echo hello"));
    assert!(is_safe_command("pwd"));

    assert!(!is_safe_command("cd ../.."));
    assert!(!is_safe_command("echo $(whoami)"));
    assert!(!is_safe_command("cmd1 && cmd2"));
}

#[test]
fn test_forbidden_command_detection() {
    let forbidden = vec!["rm -rf /".to_string(), "shutdown".to_string()];

    assert!(is_forbidden_command("rm -rf /", &forbidden));
    assert!(is_forbidden_command("shutdown now", &forbidden));
    assert!(!is_forbidden_command("ls -la", &forbidden));
}

#[tokio::test]
async fn test_shell_service_basic() {
    let dir = tempdir().unwrap();
    let config = ShellConfig {
        enabled: true,
        allowed_directory: dir.path().to_path_buf(),
        timeout_ms: 30000,
        forbidden_commands: vec![],
    };

    let mut service = ShellService::new(config);
    let result = service.execute_command("echo test", None).await.unwrap();

    assert!(result.success);
    assert!(result.stdout.contains("test"));
}

#[tokio::test]
async fn test_shell_service_history() {
    let dir = tempdir().unwrap();
    let config = ShellConfig {
        enabled: true,
        allowed_directory: dir.path().to_path_buf(),
        timeout_ms: 30000,
        forbidden_commands: vec![],
    };

    let mut service = ShellService::new(config);
    let conv_id = "integration-test";

    service
        .execute_command("echo first", Some(conv_id))
        .await
        .unwrap();
    service
        .execute_command("echo second", Some(conv_id))
        .await
        .unwrap();

    let history = service.get_command_history(conv_id, None);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].command, "echo first");
    assert_eq!(history[1].command, "echo second");
}

#[tokio::test]
async fn test_shell_service_security() {
    let dir = tempdir().unwrap();
    let config = ShellConfig {
        enabled: true,
        allowed_directory: dir.path().to_path_buf(),
        timeout_ms: 30000,
        forbidden_commands: vec!["rm".to_string()],
    };

    let mut service = ShellService::new(config);

    let result = service.execute_command("rm test.txt", None).await.unwrap();
    assert!(!result.success);
    assert!(result.stderr.contains("forbidden"));

    let result = service.execute_command("cd ../../..", None).await.unwrap();
    assert!(!result.success);
}
