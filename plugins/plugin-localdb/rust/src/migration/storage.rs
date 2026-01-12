#![allow(missing_docs)]
//! Storage for migration snapshots and journal entries.

use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::postgres::PgPool;
use sqlx::Row;
use std::sync::Arc;
use tracing::debug;

/// Storage for schema snapshots.
pub struct SnapshotStorage {
    pool: Arc<PgPool>,
}

impl SnapshotStorage {
    pub fn new(pool: Arc<PgPool>) -> Self {
        Self { pool }
    }

    pub async fn save_snapshot(
        &self,
        plugin_name: &str,
        idx: i32,
        snapshot: &Value,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO migrations._snapshots (plugin_name, idx, snapshot, created_at)
            VALUES ($1, $2, $3::jsonb, EXTRACT(EPOCH FROM NOW())::bigint)
            ON CONFLICT (plugin_name, idx)
            DO UPDATE SET
                snapshot = EXCLUDED.snapshot,
                created_at = EXTRACT(EPOCH FROM NOW())::bigint
            "#,
        )
        .bind(plugin_name)
        .bind(idx)
        .bind(snapshot)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to save snapshot")?;

        debug!(plugin_name, idx, "Saved snapshot");
        Ok(())
    }

    pub async fn get_latest_snapshot(
        &self,
        plugin_name: &str,
    ) -> Result<Option<Value>> {
        let row = sqlx::query(
            r#"
            SELECT snapshot
            FROM migrations._snapshots
            WHERE plugin_name = $1
            ORDER BY idx DESC
            LIMIT 1
            "#,
        )
        .bind(plugin_name)
        .fetch_optional(self.pool.as_ref())
        .await
        .context("Failed to get latest snapshot")?;

        if let Some(row) = row {
            Ok(Some(row.get(0)))
        } else {
            Ok(None)
        }
    }

    pub async fn get_all_snapshots(&self, plugin_name: &str) -> Result<Vec<Value>> {
        let rows = sqlx::query(
            r#"
            SELECT snapshot
            FROM migrations._snapshots
            WHERE plugin_name = $1
            ORDER BY idx ASC
            "#,
        )
        .bind(plugin_name)
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to get snapshots")?;

        Ok(rows.into_iter().map(|row| row.get(0)).collect())
    }

    pub async fn get_next_idx(&self, plugin_name: &str) -> Result<i32> {
        let row = sqlx::query_scalar(
            r#"
            SELECT COALESCE(MAX(idx), -1) + 1
            FROM migrations._snapshots
            WHERE plugin_name = $1
            "#,
        )
        .bind(plugin_name)
        .fetch_one(self.pool.as_ref())
        .await
        .context("Failed to get next snapshot index")?;

        Ok(row)
    }
}

/// Storage for migration journal entries.
pub struct JournalStorage {
    pool: Arc<PgPool>,
}

impl JournalStorage {
    pub fn new(pool: Arc<PgPool>) -> Self {
        Self { pool }
    }

    pub async fn load_journal(&self, plugin_name: &str) -> Result<Option<Value>> {
        let row = sqlx::query(
            r#"
            SELECT version, dialect, entries
            FROM migrations._journal
            WHERE plugin_name = $1
            "#,
        )
        .bind(plugin_name)
        .fetch_optional(self.pool.as_ref())
        .await
        .context("Failed to load journal")?;

        if let Some(row) = row {
            let mut journal = serde_json::Map::new();
            journal.insert("version".to_string(), Value::String(row.get(0)));
            journal.insert("dialect".to_string(), Value::String(row.get(1)));
            journal.insert("entries".to_string(), row.get(2));
            Ok(Some(Value::Object(journal)))
        } else {
            Ok(None)
        }
    }

    pub async fn save_journal(
        &self,
        plugin_name: &str,
        version: &str,
        dialect: &str,
        entries: &Value,
    ) -> Result<()> {
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
        .bind(entries)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to save journal")?;

        debug!(plugin_name, "Saved journal");
        Ok(())
    }

    /// Get the next journal index for a plugin.
    pub async fn get_next_idx(&self, plugin_name: &str) -> Result<i32> {
        let journal = self.load_journal(plugin_name).await?;
        if let Some(j) = journal {
            if let Some(entries) = j.get("entries") {
                if let Some(entries_array) = entries.as_array() {
                    return Ok(entries_array.len() as i32);
                }
            }
        }
        Ok(0)
    }

    pub async fn update_journal(
        &self,
        plugin_name: &str,
        idx: i32,
        tag: &str,
        breakpoints: bool,
    ) -> Result<()> {
        let journal = self.load_journal(plugin_name).await?;
        let mut entries = if let Some(ref j) = journal {
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
        entry.insert("version".to_string(), Value::String(tag.to_string()));
        entry.insert("breakpoints".to_string(), Value::Bool(breakpoints));
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

        self.save_journal(plugin_name, version, dialect, &Value::Array(entries))
            .await?;

        Ok(())
    }
}

