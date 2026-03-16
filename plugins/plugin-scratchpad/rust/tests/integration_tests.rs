//! Integration tests for the Scratchpad Plugin.

use elizaos_plugin_scratchpad::{
    actions::{
        ScratchpadAppendAction, ScratchpadDeleteAction, ScratchpadListAction,
        ScratchpadReadAction, ScratchpadSearchAction, ScratchpadWriteAction,
    },
    providers::ScratchpadProvider,
    ScratchpadConfig, ScratchpadReadOptions, ScratchpadSearchOptions, ScratchpadService,
    ScratchpadWriteOptions,
};
use tempfile::TempDir;

fn test_service() -> (ScratchpadService, TempDir) {
    let tmp = TempDir::new().expect("Failed to create temp dir");
    let config = ScratchpadConfig {
        base_path: tmp.path().to_string_lossy().into_owned(),
        max_file_size: 1024 * 1024,
        allowed_extensions: vec![".md".to_string(), ".txt".to_string()],
    };
    (ScratchpadService::new(config), tmp)
}

// ── Service tests ──

#[tokio::test]
async fn test_write_creates_file() {
    let (svc, _tmp) = test_service();
    let entry = svc
        .write("My Test Note", "Hello, world!", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    assert_eq!(entry.id, "my-test-note");
    assert_eq!(entry.title, "My Test Note");
    assert!(entry.content.contains("Hello, world!"));
    assert!(std::path::Path::new(&entry.path).exists());
}

#[tokio::test]
async fn test_write_with_tags() {
    let (svc, _tmp) = test_service();
    let opts = ScratchpadWriteOptions {
        tags: Some(vec!["rust".to_string(), "test".to_string()]),
        append: false,
    };
    let entry = svc.write("Tagged Note", "Content", &opts).await.unwrap();
    assert_eq!(entry.tags, vec!["rust", "test"]);
    assert!(entry.content.contains("tags: [rust, test]"));
}

#[tokio::test]
async fn test_write_sanitizes_filename() {
    let (svc, _tmp) = test_service();
    let entry = svc
        .write("Hello, World! (Test)", "Content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    assert_eq!(entry.id, "hello-world-test");
}

#[tokio::test]
async fn test_write_truncates_long_titles() {
    let (svc, _tmp) = test_service();
    let long_title = "a".repeat(200);
    let entry = svc
        .write(&long_title, "Content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    assert!(entry.id.len() <= 100);
}

#[tokio::test]
async fn test_write_append_mode() {
    let (svc, _tmp) = test_service();
    svc.write("Append Test", "First part", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let opts = ScratchpadWriteOptions {
        tags: None,
        append: true,
    };
    let entry = svc.write("Append Test", "Second part", &opts).await.unwrap();
    assert!(entry.content.contains("First part"));
    assert!(entry.content.contains("Second part"));
    assert!(entry.content.contains("---\n\nSecond part"));
}

#[tokio::test]
async fn test_write_file_size_limit() {
    let tmp = TempDir::new().unwrap();
    let config = ScratchpadConfig {
        base_path: tmp.path().to_string_lossy().into_owned(),
        max_file_size: 100,
        allowed_extensions: vec![".md".to_string()],
    };
    let svc = ScratchpadService::new(config);
    let big_content = "x".repeat(200);
    let result = svc
        .write("Big Note", &big_content, &ScratchpadWriteOptions::default())
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_read_existing_entry() {
    let (svc, _tmp) = test_service();
    svc.write("Read Me", "This is content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let entry = svc
        .read("read-me", &ScratchpadReadOptions::default())
        .await
        .unwrap();
    assert_eq!(entry.title, "Read Me");
    assert!(entry.content.contains("This is content"));
}

#[tokio::test]
async fn test_read_not_found() {
    let (svc, _tmp) = test_service();
    let result = svc
        .read("nonexistent", &ScratchpadReadOptions::default())
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_read_with_line_range() {
    let (svc, _tmp) = test_service();
    let lines: Vec<String> = (1..=20).map(|i| format!("Line {}", i)).collect();
    svc.write("Lines Note", &lines.join("\n"), &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let opts = ScratchpadReadOptions {
        from: Some(5),
        lines: Some(3),
    };
    let entry = svc.read("lines-note", &opts).await.unwrap();
    let content_lines: Vec<&str> = entry.content.split('\n').collect();
    assert_eq!(content_lines.len(), 3);
}

#[tokio::test]
async fn test_read_parses_frontmatter() {
    let (svc, _tmp) = test_service();
    let opts = ScratchpadWriteOptions {
        tags: Some(vec!["alpha".to_string(), "beta".to_string()]),
        append: false,
    };
    svc.write("Frontmatter Test", "Body", &opts).await.unwrap();

    let entry = svc
        .read("frontmatter-test", &ScratchpadReadOptions::default())
        .await
        .unwrap();
    assert_eq!(entry.title, "Frontmatter Test");
    assert_eq!(entry.tags, vec!["alpha", "beta"]);
}

#[tokio::test]
async fn test_exists_true() {
    let (svc, _tmp) = test_service();
    svc.write("Exists Test", "Content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    assert!(svc.exists("exists-test").await);
}

#[tokio::test]
async fn test_exists_false() {
    let (svc, _tmp) = test_service();
    assert!(!svc.exists("does-not-exist").await);
}

#[tokio::test]
async fn test_list_empty() {
    let (svc, _tmp) = test_service();
    let entries = svc.list().await;
    assert!(entries.is_empty());
}

#[tokio::test]
async fn test_list_multiple_entries() {
    let (svc, _tmp) = test_service();
    svc.write("First Entry", "A", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    svc.write("Second Entry", "B", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    svc.write("Third Entry", "C", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let entries = svc.list().await;
    assert_eq!(entries.len(), 3);
    // Most recently modified first
    assert_eq!(entries[0].id, "third-entry");
}

#[tokio::test]
async fn test_search_finds_matching_entries() {
    let (svc, _tmp) = test_service();
    svc.write(
        "Python Guide",
        "Learn about Python programming language",
        &ScratchpadWriteOptions::default(),
    )
    .await
    .unwrap();
    svc.write(
        "Rust Notes",
        "Rust is a systems programming language",
        &ScratchpadWriteOptions::default(),
    )
    .await
    .unwrap();
    svc.write(
        "Shopping List",
        "Buy milk and eggs",
        &ScratchpadWriteOptions::default(),
    )
    .await
    .unwrap();

    let results = svc
        .search("programming language", &ScratchpadSearchOptions::default())
        .await;
    assert!(results.len() >= 2);
    let ids: Vec<&str> = results.iter().map(|r| r.entry_id.as_str()).collect();
    assert!(ids.contains(&"python-guide"));
    assert!(ids.contains(&"rust-notes"));
}

#[tokio::test]
async fn test_search_no_results() {
    let (svc, _tmp) = test_service();
    svc.write("Random", "Nothing related", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    let results = svc
        .search(
            "quantum physics simulation",
            &ScratchpadSearchOptions::default(),
        )
        .await;
    assert!(results.is_empty());
}

#[tokio::test]
async fn test_search_max_results() {
    let (svc, _tmp) = test_service();
    for i in 0..10 {
        svc.write(
            &format!("Note {}", i),
            &format!("Contains the keyword searchable item {}", i),
            &ScratchpadWriteOptions::default(),
        )
        .await
        .unwrap();
    }

    let opts = ScratchpadSearchOptions {
        max_results: 3,
        min_score: 0.1,
    };
    let results = svc.search("keyword searchable", &opts).await;
    assert!(results.len() <= 3);
}

#[tokio::test]
async fn test_search_scores_are_bounded() {
    let (svc, _tmp) = test_service();
    let content = "term ".repeat(100);
    svc.write("Score Test", &content, &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let results = svc
        .search("term", &ScratchpadSearchOptions::default())
        .await;
    for r in &results {
        assert!(r.score >= 0.0 && r.score <= 1.0);
    }
}

#[tokio::test]
async fn test_search_ignores_short_terms() {
    let (svc, _tmp) = test_service();
    svc.write("Short", "This is a test", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    // "is" and "a" are <= 2 chars → no valid query terms
    let results = svc
        .search("is a", &ScratchpadSearchOptions::default())
        .await;
    assert!(results.is_empty());
}

#[tokio::test]
async fn test_delete_existing_entry() {
    let (svc, _tmp) = test_service();
    svc.write("Delete Me", "Content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    assert!(svc.exists("delete-me").await);

    let deleted = svc.delete("delete-me").await.unwrap();
    assert!(deleted);
    assert!(!svc.exists("delete-me").await);
}

#[tokio::test]
async fn test_delete_nonexistent_entry() {
    let (svc, _tmp) = test_service();
    let deleted = svc.delete("nonexistent").await.unwrap();
    assert!(!deleted);
}

#[tokio::test]
async fn test_get_summary_empty() {
    let (svc, _tmp) = test_service();
    let summary = svc.get_summary().await;
    assert_eq!(summary, "No scratchpad entries found.");
}

#[tokio::test]
async fn test_get_summary_with_entries() {
    let (svc, _tmp) = test_service();
    svc.write("Summary Test", "Preview content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    let summary = svc.get_summary().await;
    assert!(summary.contains("Scratchpad Summary"));
    assert!(summary.contains("Summary Test"));
}

#[tokio::test]
async fn test_get_base_path() {
    let (svc, tmp) = test_service();
    assert_eq!(svc.get_base_path(), tmp.path().to_string_lossy());
}

// ── Action metadata tests ──

#[tokio::test]
async fn test_action_metadata() {
    assert_eq!(ScratchpadWriteAction::NAME, "SCRATCHPAD_WRITE");
    assert!(!ScratchpadWriteAction::DESCRIPTION.is_empty());
    assert!(!ScratchpadWriteAction::SIMILES.is_empty());
    assert!(ScratchpadWriteAction::SIMILES.contains(&"SAVE_NOTE"));

    assert_eq!(ScratchpadReadAction::NAME, "SCRATCHPAD_READ");
    assert!(!ScratchpadReadAction::DESCRIPTION.is_empty());
    assert!(ScratchpadReadAction::SIMILES.contains(&"READ_NOTE"));

    assert_eq!(ScratchpadSearchAction::NAME, "SCRATCHPAD_SEARCH");
    assert!(!ScratchpadSearchAction::DESCRIPTION.is_empty());
    assert!(ScratchpadSearchAction::SIMILES.contains(&"SEARCH_NOTES"));

    assert_eq!(ScratchpadListAction::NAME, "SCRATCHPAD_LIST");
    assert!(!ScratchpadListAction::DESCRIPTION.is_empty());
    assert!(ScratchpadListAction::SIMILES.contains(&"LIST_NOTES"));

    assert_eq!(ScratchpadDeleteAction::NAME, "SCRATCHPAD_DELETE");
    assert!(!ScratchpadDeleteAction::DESCRIPTION.is_empty());
    assert!(ScratchpadDeleteAction::SIMILES.contains(&"DELETE_NOTE"));

    assert_eq!(ScratchpadAppendAction::NAME, "SCRATCHPAD_APPEND");
    assert!(!ScratchpadAppendAction::DESCRIPTION.is_empty());
    assert!(ScratchpadAppendAction::SIMILES.contains(&"ADD_TO_NOTE"));
}

#[tokio::test]
async fn test_provider_metadata() {
    assert_eq!(ScratchpadProvider::NAME, "scratchpad");
    assert!(!ScratchpadProvider::DESCRIPTION.is_empty());
    assert!(ScratchpadProvider::DYNAMIC);
}

// ── Action handler tests ──

#[tokio::test]
async fn test_write_action_handler() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadWriteAction::handle(
        &svc,
        "Action Write Test",
        "Testing write action",
        Some(vec!["test".to_string()]),
    )
    .await;
    assert!(result.success);
    assert!(result.entry_id.is_some());
    assert!(result.text.contains("saved a note"));
}

#[tokio::test]
async fn test_write_action_empty_title() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadWriteAction::handle(&svc, "", "Content", None).await;
    assert!(!result.success);
    assert!(result.text.contains("required"));
}

#[tokio::test]
async fn test_read_action_handler() {
    let (svc, _tmp) = test_service();
    svc.write("Read Action", "Content for reading", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let result = ScratchpadReadAction::handle(
        &svc,
        "read-action",
        &ScratchpadReadOptions::default(),
    )
    .await;
    assert!(result.success);
    assert!(result.entry.is_some());
    assert!(result.text.contains("Read Action"));
}

#[tokio::test]
async fn test_read_action_not_found() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadReadAction::handle(
        &svc,
        "nonexistent",
        &ScratchpadReadOptions::default(),
    )
    .await;
    assert!(!result.success);
}

#[tokio::test]
async fn test_search_action_handler() {
    let (svc, _tmp) = test_service();
    svc.write(
        "Search Action",
        "Contains searchable content",
        &ScratchpadWriteOptions::default(),
    )
    .await
    .unwrap();

    let result = ScratchpadSearchAction::handle(
        &svc,
        "searchable content",
        &ScratchpadSearchOptions::default(),
    )
    .await;
    assert!(result.success);
    assert!(!result.results.is_empty());
}

#[tokio::test]
async fn test_list_action_handler() {
    let (svc, _tmp) = test_service();
    svc.write("List Test A", "A", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    svc.write("List Test B", "B", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let result = ScratchpadListAction::handle(&svc).await;
    assert!(result.success);
    assert_eq!(result.entries.len(), 2);
    assert!(result.text.contains("2 total"));
}

#[tokio::test]
async fn test_list_action_empty() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadListAction::handle(&svc).await;
    assert!(result.success);
    assert!(result.entries.is_empty());
    assert!(result.text.contains("don't have any"));
}

#[tokio::test]
async fn test_delete_action_handler() {
    let (svc, _tmp) = test_service();
    svc.write("Delete Action", "Content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let result = ScratchpadDeleteAction::handle(&svc, "delete-action").await;
    assert!(result.success);
    assert!(result.text.contains("deleted"));
    assert!(!svc.exists("delete-action").await);
}

#[tokio::test]
async fn test_delete_action_not_found() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadDeleteAction::handle(&svc, "nonexistent").await;
    assert!(!result.success);
    assert!(result.text.contains("not found"));
}

#[tokio::test]
async fn test_append_action_handler() {
    let (svc, _tmp) = test_service();
    svc.write("Append Action", "Original content", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let result = ScratchpadAppendAction::handle(&svc, "append-action", "Appended text").await;
    assert!(result.success);
    assert!(result.text.contains("appended"));

    let entry = svc
        .read("append-action", &ScratchpadReadOptions::default())
        .await
        .unwrap();
    assert!(entry.content.contains("Original content"));
    assert!(entry.content.contains("Appended text"));
}

#[tokio::test]
async fn test_append_action_not_found() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadAppendAction::handle(&svc, "nonexistent", "Content").await;
    assert!(!result.success);
    assert!(result.text.contains("not found"));
}

// ── Provider test ──

#[tokio::test]
async fn test_provider_empty() {
    let (svc, _tmp) = test_service();
    let result = ScratchpadProvider::get(&svc).await;
    assert!(result.text.contains("No scratchpad entries"));
    assert_eq!(result.values["scratchpadCount"], serde_json::json!(0));
}

#[tokio::test]
async fn test_provider_with_entries() {
    let (svc, _tmp) = test_service();
    svc.write("Provider Note A", "Content A", &ScratchpadWriteOptions::default())
        .await
        .unwrap();
    svc.write("Provider Note B", "Content B", &ScratchpadWriteOptions::default())
        .await
        .unwrap();

    let result = ScratchpadProvider::get(&svc).await;
    assert!(result.text.contains("2 entries available"));
    assert_eq!(result.values["scratchpadCount"], serde_json::json!(2));
    assert!(result.data.contains_key("entries"));
    assert!(result.data.contains_key("basePath"));
}

// ── Config tests ──

#[tokio::test]
async fn test_config_default_valid() {
    let config = ScratchpadConfig::default();
    assert!(config.validate().is_ok());
}

#[tokio::test]
async fn test_config_invalid_file_size() {
    let config = ScratchpadConfig {
        max_file_size: 100,
        ..Default::default()
    };
    assert!(config.validate().is_err());
}

#[tokio::test]
async fn test_config_empty_extensions() {
    let config = ScratchpadConfig {
        allowed_extensions: vec![],
        ..Default::default()
    };
    assert!(config.validate().is_err());
}

#[tokio::test]
async fn test_config_builder() {
    let config = ScratchpadConfig::default()
        .with_base_path("/custom/path")
        .with_max_file_size(2048);
    assert_eq!(config.base_path, "/custom/path");
    assert_eq!(config.max_file_size, 2048);
}
