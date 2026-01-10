//! Integration tests for the GitHub plugin

use elizaos_plugin_github::{GitHubConfig, PLUGIN_NAME, PLUGIN_VERSION};

#[test]
fn test_plugin_metadata() {
    assert_eq!(PLUGIN_NAME, "github");
    assert!(!PLUGIN_VERSION.is_empty());
}

#[test]
fn test_config_new() {
    let config = GitHubConfig::new("test_token".to_string());
    assert_eq!(config.api_token, "test_token");
    assert_eq!(config.branch, "main");
    assert!(config.owner.is_none());
    assert!(config.repo.is_none());
}

#[test]
fn test_config_builder() {
    let config = GitHubConfig::new("test_token".to_string())
        .with_owner("test-owner".to_string())
        .with_repo("test-repo".to_string())
        .with_branch("develop".to_string());

    assert_eq!(config.owner, Some("test-owner".to_string()));
    assert_eq!(config.repo, Some("test-repo".to_string()));
    assert_eq!(config.branch, "develop");
}

#[test]
fn test_config_get_repository_ref() {
    let config = GitHubConfig::new("token".to_string())
        .with_owner("default-owner".to_string())
        .with_repo("default-repo".to_string());

    // Use defaults
    let (owner, repo) = config.get_repository_ref(None, None).unwrap();
    assert_eq!(owner, "default-owner");
    assert_eq!(repo, "default-repo");

    // Override
    let (owner, repo) = config
        .get_repository_ref(Some("override-owner"), Some("override-repo"))
        .unwrap();
    assert_eq!(owner, "override-owner");
    assert_eq!(repo, "override-repo");

    // Partial override
    let (owner, repo) = config
        .get_repository_ref(Some("override-owner"), None)
        .unwrap();
    assert_eq!(owner, "override-owner");
    assert_eq!(repo, "default-repo");
}

#[test]
fn test_config_validation_empty_token() {
    let config = GitHubConfig::new("".to_string());
    assert!(config.validate().is_err());
}

#[test]
fn test_config_validation_valid() {
    let config = GitHubConfig::new("valid_token".to_string());
    assert!(config.validate().is_ok());
}

