#![allow(missing_docs)]
//! Migration tracker for recording migration history.

use anyhow::{Context, Result};
use sqlx::postgres::PgPool;
use sqlx::Row;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::debug;

/// Tracks migration history per plugin.
pub struct MigrationTracker {
    pool: Arc<PgPool>,
}

impl MigrationTracker {
    pub fn new(pool: Arc<PgPool>) -> Self {
        Self { pool }
    }

    pub async fn ensure_tables(&self) -> Result<()> {
        // Create migrations schema
        sqlx::query("CREATE SCHEMA IF NOT EXISTS migrations")
            .execute(self.pool.as_ref())
            .await
            .context("Failed to create migrations schema")?;

        // Create migrations table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS migrations._migrations (
                id SERIAL PRIMARY KEY,
                plugin_name TEXT NOT NULL,
                hash TEXT NOT NULL,
                created_at BIGINT NOT NULL
            )
            "#,
        )
        .execute(self.pool.as_ref())
        .await
        .context("Failed to create _migrations table")?;

        // Create index on plugin_name
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_migrations_plugin_name ON migrations._migrations(plugin_name)",
        )
        .execute(self.pool.as_ref())
        .await
        .context("Failed to create index on _migrations")?;

        // Create journal table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS migrations._journal (
                plugin_name TEXT PRIMARY KEY,
                version TEXT NOT NULL,
                dialect TEXT NOT NULL DEFAULT 'postgresql',
                entries JSONB NOT NULL DEFAULT '[]'::jsonb
            )
            "#,
        )
        .execute(self.pool.as_ref())
        .await
        .context("Failed to create _journal table")?;

        // Create snapshots table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS migrations._snapshots (
                id SERIAL PRIMARY KEY,
                plugin_name TEXT NOT NULL,
                idx INTEGER NOT NULL,
                snapshot JSONB NOT NULL,
                created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::bigint,
                UNIQUE(plugin_name, idx)
            )
            "#,
        )
        .execute(self.pool.as_ref())
        .await
        .context("Failed to create _snapshots table")?;

        // Create index on plugin_name for snapshots
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_plugin_name ON migrations._snapshots(plugin_name)",
        )
        .execute(self.pool.as_ref())
        .await
        .context("Failed to create index on _snapshots")?;

        debug!("Migration tracking tables initialized");
        Ok(())
    }

    pub async fn get_last_migration(
        &self,
        plugin_name: &str,
    ) -> Result<Option<(i32, String, i64)>> {
        let row = sqlx::query(
            r#"
            SELECT id, hash, created_at
            FROM migrations._migrations
            WHERE plugin_name = $1
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(plugin_name)
        .fetch_optional(self.pool.as_ref())
        .await
        .context("Failed to query last migration")?;

        if let Some(row) = row {
            Ok(Some((
                row.get(0),
                row.get(1),
                row.get(2),
            )))
        } else {
            Ok(None)
        }
    }

    pub async fn record_migration(
        &self,
        plugin_name: &str,
        hash: &str,
        created_at: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO migrations._migrations (plugin_name, hash, created_at)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(plugin_name)
        .bind(hash)
        .bind(created_at)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to record migration")?;

        debug!(plugin_name, hash, "Recorded migration");
        Ok(())
    }

    pub async fn get_status(&self, plugin_name: &str) -> Result<HashMap<String, String>> {
        let last_migration = self.get_last_migration(plugin_name).await?;

        let mut status = HashMap::new();
        status.insert("hasRun".to_string(), last_migration.is_some().to_string());

        if let Some((id, hash, created_at)) = last_migration {
            status.insert("lastMigrationId".to_string(), id.to_string());
            status.insert("lastMigrationHash".to_string(), hash);
            status.insert("lastMigrationCreatedAt".to_string(), created_at.to_string());
        }

        // Count snapshots
        let snapshot_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM migrations._snapshots
            WHERE plugin_name = $1
            "#,
        )
        .bind(plugin_name)
        .fetch_one(self.pool.as_ref())
        .await
        .context("Failed to count snapshots")?;

        status.insert("snapshots".to_string(), snapshot_count.to_string());

        Ok(status)
    }
}

