//! Integration tests for migration service.

#![cfg(feature = "native")]

use elizaos_plugin_sql::migration::{
    JournalStorage, MigrationService, MigrationTracker, SnapshotStorage,
};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use std::time::Duration;

/// Create a test database connection.
async fn create_test_pool() -> Result<sqlx::PgPool, sqlx::Error> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost/eliza_test".to_string());

    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
}

/// Clean up test data.
async fn cleanup_test_data(pool: &sqlx::PgPool, plugin_name: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM migrations._migrations WHERE plugin_name = $1")
        .bind(plugin_name)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM migrations._snapshots WHERE plugin_name = $1")
        .bind(plugin_name)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM migrations._journal WHERE plugin_name = $1")
        .bind(plugin_name)
        .execute(pool)
        .await?;
    Ok(())
}

#[tokio::test]
async fn test_migration_service_initialization() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    let service = MigrationService::new(pool.clone());

    // Initialize should create migration tables
    let result = service.initialize().await;
    assert!(
        result.is_ok(),
        "Failed to initialize migration service: {:?}",
        result.err()
    );

    pool.close().await;
}

#[tokio::test]
async fn test_record_migration() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    let service = MigrationService::new(pool.clone());
    service.initialize().await.unwrap();

    let plugin_name = "@test/migration-record-test";
    let _ = cleanup_test_data(&pool, plugin_name).await;

    let snapshot = json!({
        "version": "1.0.0",
        "tables": {
            "test_table": {
                "name": "test_table",
                "columns": {
                    "id": {"type": "uuid"},
                    "name": {"type": "text"}
                }
            }
        }
    });

    let hash = "abcdef1234567890";
    let result = service.record_migration(plugin_name, hash, &snapshot).await;
    assert!(
        result.is_ok(),
        "Failed to record migration: {:?}",
        result.err()
    );

    // Verify status
    let status = service.get_status(plugin_name).await.unwrap();
    assert!(status
        .get("hasRun")
        .and_then(|v| v.as_bool())
        .unwrap_or(false));

    cleanup_test_data(&pool, plugin_name).await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn test_migration_tracker() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    let pool_arc = Arc::new(pool.clone());
    let tracker = MigrationTracker::new(pool_arc);

    // Ensure tables exist
    let result = tracker.ensure_tables().await;
    assert!(
        result.is_ok(),
        "Failed to ensure tables: {:?}",
        result.err()
    );

    let plugin_name = "@test/tracker-test";
    let _ = cleanup_test_data(&pool, plugin_name).await;

    // Record a migration
    let hash = "test_hash_12345";
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let result = tracker
        .record_migration(plugin_name, hash, created_at)
        .await;
    assert!(
        result.is_ok(),
        "Failed to record migration: {:?}",
        result.err()
    );

    // Get last migration
    let last = tracker.get_last_migration(plugin_name).await.unwrap();
    assert!(last.is_some());
    let (_, recorded_hash, _) = last.unwrap();
    assert_eq!(recorded_hash, hash);

    cleanup_test_data(&pool, plugin_name).await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn test_snapshot_storage() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    // First ensure tables exist
    let service = MigrationService::new(pool.clone());
    service.initialize().await.unwrap();

    let pool_arc = Arc::new(pool.clone());
    let storage = SnapshotStorage::new(pool_arc);

    let plugin_name = "@test/snapshot-test";
    let _ = cleanup_test_data(&pool, plugin_name).await;

    let snapshot = json!({
        "version": "1.0.0",
        "tables": {"users": {"id": "uuid"}}
    });

    // Save snapshot
    let result = storage.save_snapshot(plugin_name, 0, &snapshot).await;
    assert!(
        result.is_ok(),
        "Failed to save snapshot: {:?}",
        result.err()
    );

    // Get latest snapshot
    let latest = storage.get_latest_snapshot(plugin_name).await.unwrap();
    assert!(latest.is_some());

    let retrieved = latest.unwrap();
    assert_eq!(
        retrieved.get("version").and_then(|v| v.as_str()),
        Some("1.0.0")
    );

    cleanup_test_data(&pool, plugin_name).await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn test_multiple_snapshots() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    let service = MigrationService::new(pool.clone());
    service.initialize().await.unwrap();

    let pool_arc = Arc::new(pool.clone());
    let storage = SnapshotStorage::new(pool_arc);

    let plugin_name = "@test/multi-snapshot-test";
    let _ = cleanup_test_data(&pool, plugin_name).await;

    // Save multiple snapshots
    let snapshot1 = json!({"version": "1.0.0"});
    let snapshot2 = json!({"version": "2.0.0-alpha"});
    let snapshot3 = json!({"version": "3.0.0"});

    storage
        .save_snapshot(plugin_name, 0, &snapshot1)
        .await
        .unwrap();
    storage
        .save_snapshot(plugin_name, 1, &snapshot2)
        .await
        .unwrap();
    storage
        .save_snapshot(plugin_name, 2, &snapshot3)
        .await
        .unwrap();

    // Get all snapshots
    let all = storage.get_all_snapshots(plugin_name).await.unwrap();
    assert_eq!(all.len(), 3);

    // Latest should be version 3.0.0
    let latest = storage.get_latest_snapshot(plugin_name).await.unwrap();
    assert_eq!(
        latest.unwrap().get("version").and_then(|v| v.as_str()),
        Some("3.0.0")
    );

    // Next index should be 3
    let next_idx = storage.get_next_idx(plugin_name).await.unwrap();
    assert_eq!(next_idx, 3);

    cleanup_test_data(&pool, plugin_name).await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn test_journal_storage() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    let service = MigrationService::new(pool.clone());
    service.initialize().await.unwrap();

    let pool_arc = Arc::new(pool.clone());
    let storage = JournalStorage::new(pool_arc);

    let plugin_name = "@test/journal-test";
    let _ = cleanup_test_data(&pool, plugin_name).await;

    // Save journal
    let entries = json!([
        {"idx": 0, "version": "0000_initial", "breakpoints": true}
    ]);

    let result = storage
        .save_journal(plugin_name, "0.0.1", "postgresql", &entries)
        .await;
    assert!(result.is_ok(), "Failed to save journal: {:?}", result.err());

    // Load journal
    let journal = storage.load_journal(plugin_name).await.unwrap();
    assert!(journal.is_some());

    let j = journal.unwrap();
    assert_eq!(j.get("version").and_then(|v| v.as_str()), Some("0.0.1"));
    assert_eq!(
        j.get("dialect").and_then(|v| v.as_str()),
        Some("postgresql")
    );

    cleanup_test_data(&pool, plugin_name).await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn test_multiple_plugins() {
    let pool = match create_test_pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Skipping test - database not available: {}", e);
            return;
        }
    };

    let service = MigrationService::new(pool.clone());
    service.initialize().await.unwrap();

    let plugin1 = "@test/plugin-one";
    let plugin2 = "@test/plugin-two";

    let _ = cleanup_test_data(&pool, plugin1).await;
    let _ = cleanup_test_data(&pool, plugin2).await;

    // Record migrations for different plugins
    service
        .record_migration(plugin1, "hash1", &json!({"v": 1}))
        .await
        .unwrap();
    service
        .record_migration(plugin2, "hash2", &json!({"v": 2}))
        .await
        .unwrap();

    // Each plugin should have its own status
    let status1 = service.get_status(plugin1).await.unwrap();
    let status2 = service.get_status(plugin2).await.unwrap();

    assert!(status1
        .get("hasRun")
        .and_then(|v| v.as_bool())
        .unwrap_or(false));
    assert!(status2
        .get("hasRun")
        .and_then(|v| v.as_bool())
        .unwrap_or(false));

    cleanup_test_data(&pool, plugin1).await.unwrap();
    cleanup_test_data(&pool, plugin2).await.unwrap();
    pool.close().await;
}

/// Test schema name derivation - import from actual module
mod schema_namespacing {
    use elizaos_plugin_sql::migration::derive_schema_name;

    #[test]
    fn test_core_plugin_uses_public() {
        assert_eq!(derive_schema_name("@elizaos/plugin-sql"), "public");
    }

    #[test]
    fn test_scope_and_prefix_removed() {
        // npm scope and plugin- prefix are removed
        assert_eq!(derive_schema_name("@your-org/plugin-name"), "name");
        assert_eq!(derive_schema_name("@elizaos/plugin-bootstrap"), "bootstrap");
    }

    #[test]
    fn test_simple_names() {
        assert_eq!(derive_schema_name("my-plugin"), "my_plugin");
        assert_eq!(derive_schema_name("plugin-test"), "test");
    }

    #[test]
    fn test_special_characters_normalized() {
        assert_eq!(derive_schema_name("@org/plugin.name!"), "plugin_name");
    }

    #[test]
    fn test_numeric_prefix_handled() {
        // Names starting with non-alpha get prefixed
        assert_eq!(derive_schema_name("123plugin"), "p_123plugin");
    }

    #[test]
    fn test_lowercase_conversion() {
        assert_eq!(derive_schema_name("@MyOrg/MyPlugin"), "myplugin");
        assert_eq!(derive_schema_name("myplugin"), "myplugin");
        assert_eq!(derive_schema_name("MyPlugin"), "myplugin");
    }

    #[test]
    fn test_numeric_in_name() {
        assert_eq!(derive_schema_name("@org/plugin-test123"), "test123");
        // "plugin2go" doesn't have "plugin-" prefix (hyphen required), so it stays as is
        assert_eq!(derive_schema_name("plugin2go"), "plugin2go");
        // But "plugin-2go" has the prefix, so it becomes "p_2go" (starts with number)
        assert_eq!(derive_schema_name("plugin-2go"), "p_2go");
    }
}

/// Edge case tests
mod edge_cases {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_short_hash() {
        let pool = match create_test_pool().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Skipping test - database not available: {}", e);
                return;
            }
        };

        let service = MigrationService::new(pool.clone());
        service.initialize().await.unwrap();

        let plugin_name = "@test/short-hash";
        let _ = cleanup_test_data(&pool, plugin_name).await;

        // Test with a very short hash (should not panic)
        let result = service
            .record_migration(plugin_name, "abc", &json!({}))
            .await;
        assert!(result.is_ok(), "Should handle short hash without panicking");

        cleanup_test_data(&pool, plugin_name).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn test_empty_snapshot() {
        let pool = match create_test_pool().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Skipping test - database not available: {}", e);
                return;
            }
        };

        let service = MigrationService::new(pool.clone());
        service.initialize().await.unwrap();

        let plugin_name = "@test/empty-snapshot";
        let _ = cleanup_test_data(&pool, plugin_name).await;

        // Record with empty snapshot
        let result = service
            .record_migration(plugin_name, "hash", &json!({}))
            .await;
        assert!(result.is_ok());

        let snapshot = service.get_latest_snapshot(plugin_name).await.unwrap();
        assert!(snapshot.is_some());
        assert_eq!(snapshot.unwrap(), json!({}));

        cleanup_test_data(&pool, plugin_name).await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn test_unicode_in_snapshot() {
        let pool = match create_test_pool().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Skipping test - database not available: {}", e);
                return;
            }
        };

        let service = MigrationService::new(pool.clone());
        service.initialize().await.unwrap();

        let plugin_name = "@test/unicode";
        let _ = cleanup_test_data(&pool, plugin_name).await;

        let snapshot = json!({
            "description": "Unicode: 你好世界 🚀 émojis 日本語",
            "data": {"key": "value with émojis 🎉"}
        });

        let result = service
            .record_migration(plugin_name, "unicode_hash", &snapshot)
            .await;
        assert!(result.is_ok());

        let retrieved = service.get_latest_snapshot(plugin_name).await.unwrap();
        assert!(retrieved.is_some());
        let s = retrieved.unwrap();
        assert_eq!(
            s.get("description").and_then(|v| v.as_str()),
            Some("Unicode: 你好世界 🚀 émojis 日本語")
        );

        cleanup_test_data(&pool, plugin_name).await.unwrap();
        pool.close().await;
    }
}
