#![allow(missing_docs)]

use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::postgres::PgPool;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, info};

use super::storage::{JournalStorage, SnapshotStorage};
use super::tracker::MigrationTracker;

pub struct MigrationService {
    tracker: MigrationTracker,
    journal_storage: JournalStorage,
    snapshot_storage: SnapshotStorage,
    pool: Arc<PgPool>,
}

impl MigrationService {
    pub fn new(pool: PgPool) -> Self {
        let pool_arc = Arc::new(pool);
        Self {
            tracker: MigrationTracker::new(Arc::clone(&pool_arc)),
            journal_storage: JournalStorage::new(Arc::clone(&pool_arc)),
            snapshot_storage: SnapshotStorage::new(Arc::clone(&pool_arc)),
            pool: pool_arc,
        }
    }

    pub async fn initialize(&self) -> Result<()> {
        self.tracker.ensure_tables().await?;
        info!("Migration service initialized");
        Ok(())
    }

    pub async fn get_status(&self, plugin_name: &str) -> Result<Value> {
        let last_migration = self.tracker.get_last_migration(plugin_name).await?;
        let latest_snapshot = self.snapshot_storage.get_latest_snapshot(plugin_name).await?;

        let mut status = serde_json::Map::new();
        status.insert(
            "hasRun".to_string(),
            Value::Bool(last_migration.is_some()),
        );

        if let Some((id, hash, created_at)) = last_migration {
            let mut migration = serde_json::Map::new();
            migration.insert("id".to_string(), Value::Number(id.into()));
            migration.insert("hash".to_string(), Value::String(hash));
            migration.insert("createdAt".to_string(), Value::Number(created_at.into()));
            status.insert("lastMigration".to_string(), Value::Object(migration));
        }

        if let Some(snapshot) = latest_snapshot {
            status.insert("latestSnapshot".to_string(), snapshot);
        }

        // Count snapshots
        let snapshots = self.snapshot_storage.get_all_snapshots(plugin_name).await?;
        status.insert("snapshots".to_string(), Value::Number(snapshots.len().into()));

        Ok(Value::Object(status))
    }

    pub async fn record_migration(
        &self,
        plugin_name: &str,
        hash: &str,
        snapshot: &Value,
    ) -> Result<()> {
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("Time went backwards")?
            .as_millis() as i64;

        // Get next index
        let idx = self.snapshot_storage.get_next_idx(plugin_name).await?;

        // Start transaction
        let mut tx = self.pool.as_ref().begin().await.context("Failed to begin transaction")?;

        // Record migration
        sqlx::query(
            r#"
            INSERT INTO migrations._migrations (plugin_name, hash, created_at)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(plugin_name)
        .bind(hash)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .context("Failed to record migration")?;

        // Save snapshot
        sqlx::query(
            r#"
            INSERT INTO migrations._snapshots (plugin_name, idx, snapshot, created_at)
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (plugin_name, idx)
            DO UPDATE SET
                snapshot = EXCLUDED.snapshot,
                created_at = EXCLUDED.created_at
            "#,
        )
        .bind(plugin_name)
        .bind(idx)
        .bind(snapshot)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .context("Failed to save snapshot")?;

        // Update journal (within transaction)
        // Safely slice hash to avoid panic if hash is too short
        let hash_prefix = if hash.len() >= 8 {
            &hash[..8]
        } else {
            hash
        };
        let tag = format!("{:04}_{}", idx, hash_prefix);
        let journal = self.journal_storage.load_journal(plugin_name).await?;
        let mut entries = if let Some(j) = &journal {
            j.get("entries")
                .and_then(|e| e.as_array())
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        // Add new entry
        let mut entry = serde_json::Map::new();
        entry.insert("idx".to_string(), Value::Number(idx.into()));
        entry.insert("version".to_string(), Value::String(tag.clone()));
        entry.insert("breakpoints".to_string(), Value::Bool(true));
        entries.push(Value::Object(entry));

        let version = journal
            .as_ref()
            .and_then(|j| j.get("version"))
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.1");
        let dialect = journal
            .as_ref()
            .and_then(|j| j.get("dialect"))
            .and_then(|d| d.as_str())
            .unwrap_or("postgresql");

        sqlx::query(
            r#"
            INSERT INTO migrations._journal (plugin_name, version, dialect, entries)
            VALUES ($1, $2, $3, $4::jsonb)
            ON CONFLICT (plugin_name)
            DO UPDATE SET
                version = EXCLUDED.version,
                dialect = EXCLUDED.dialect,
                entries = EXCLUDED.entries
            "#,
        )
        .bind(plugin_name)
        .bind(version)
        .bind(dialect)
        .bind(&Value::Array(entries))
        .execute(&mut *tx)
        .await
        .context("Failed to update journal")?;

        tx.commit().await.context("Failed to commit migration")?;

        debug!(plugin_name, hash, "Recorded migration");
        Ok(())
    }

    pub async fn get_latest_snapshot(&self, plugin_name: &str) -> Result<Option<Value>> {
        self.snapshot_storage.get_latest_snapshot(plugin_name).await
    }
}

