use elizaos_plugin_code::{
    is_forbidden_command, is_safe_command, validate_path, CodeConfig, CoderService,
};
use tempfile::tempdir;

#[test]
fn test_path_validation() {
    let dir = tempdir().unwrap();
    let allowed = dir.path().to_path_buf();
    let current = dir.path().to_path_buf();

    let ok = validate_path("subfolder", &allowed, &current);
    assert!(ok.is_some());

    let bad = validate_path("../../../etc", &allowed, &current);
    assert!(bad.is_none());
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
async fn test_service_file_ops() {
    let dir = tempdir().unwrap();
    let cfg = CodeConfig {
        enabled: true,
        allowed_directory: dir.path().to_path_buf(),
        timeout_ms: 30_000,
        forbidden_commands: vec![],
    };
    let service = CoderService::new(cfg);
    let conv = "conv";

    service.write_file(conv, "a.txt", "hello").await.unwrap();
    let content = service.read_file(conv, "a.txt").await.unwrap();
    assert!(content.contains("hello"));

    service
        .edit_file(conv, "a.txt", "hello", "hi")
        .await
        .unwrap();
    let content2 = service.read_file(conv, "a.txt").await.unwrap();
    assert!(content2.contains("hi"));

    let items = service.list_files(conv, ".").await.unwrap();
    assert!(items.iter().any(|x| x == "a.txt"));
}

#[tokio::test]
async fn test_service_shell_and_history() {
    let dir = tempdir().unwrap();
    let cfg = CodeConfig {
        enabled: true,
        allowed_directory: dir.path().to_path_buf(),
        timeout_ms: 30_000,
        forbidden_commands: vec![],
    };
    let mut service = CoderService::new(cfg);
    let conv = "conv-history";

    let res = service.execute_shell(conv, "pwd").await.unwrap();
    assert!(res.success);

    let history = service.get_command_history(conv, None);
    assert_eq!(history.len(), 1);
}

#[tokio::test]
async fn test_service_security() {
    let dir = tempdir().unwrap();
    let cfg = CodeConfig {
        enabled: true,
        allowed_directory: dir.path().to_path_buf(),
        timeout_ms: 30_000,
        forbidden_commands: vec!["rm".to_string()],
    };
    let mut service = CoderService::new(cfg);
    let conv = "conv-sec";

    let res = service.execute_shell(conv, "rm test.txt").await.unwrap();
    assert!(!res.success);

    let cd = service.change_directory(conv, "..").await;
    assert!(!cd.success);
}
