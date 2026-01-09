//! PostgreSQL connection manager for elizaOS

use anyhow::{Context, Result};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;
use tracing::{debug, info};

/// PostgreSQL connection manager
pub struct PostgresConnectionManager {
    pool: PgPool,
    connection_string: String,
}

impl PostgresConnectionManager {
    /// Create a new connection manager
    pub async fn new(connection_string: &str) -> Result<Self> {
        info!("Connecting to PostgreSQL...");

        let pool = PgPoolOptions::new()
            .max_connections(10)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(30))
            .idle_timeout(Duration::from_secs(600))
            .connect(connection_string)
            .await
            .context("Failed to connect to PostgreSQL")?;

        info!("Connected to PostgreSQL successfully");

        Ok(PostgresConnectionManager {
            pool,
            connection_string: connection_string.to_string(),
        })
    }

    /// Get the connection pool
    pub fn get_pool(&self) -> &PgPool {
        &self.pool
    }

    /// Test the connection
    pub async fn test_connection(&self) -> Result<bool> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .context("Connection test failed")?;
        Ok(true)
    }

    /// Close all connections
    pub async fn close(&self) {
        debug!("Closing PostgreSQL connection pool");
        self.pool.close().await;
    }

    /// Run database migrations
    pub async fn run_migrations(&self) -> Result<()> {
        use crate::schema::*;

        // Create vector extension
        sqlx::query(embedding::ENSURE_VECTOR_EXTENSION)
            .execute(&self.pool)
            .await
            .context("Failed to create vector extension")?;

        // Create tables in order (respecting foreign key constraints)
        let static_migrations = [
            agent::CREATE_AGENTS_TABLE,
            agent::CREATE_AGENTS_INDEXES,
            world::CREATE_WORLDS_TABLE,
            world::CREATE_WORLDS_INDEXES,
            entity::CREATE_ENTITIES_TABLE,
            entity::CREATE_ENTITIES_INDEXES,
            room::CREATE_ROOMS_TABLE,
            room::CREATE_ROOMS_INDEXES,
            memory::CREATE_MEMORIES_TABLE,
            memory::CREATE_MEMORIES_INDEXES,
        ];

        for migration in static_migrations {
            sqlx::query(migration)
                .execute(&self.pool)
                .await
                .context("Failed to run migration")?;
        }

        // Create embeddings table with dynamic dimension
        let embedding_sql = embedding::create_embeddings_table_sql(embedding::DEFAULT_DIMENSION);
        sqlx::query(&embedding_sql)
            .execute(&self.pool)
            .await
            .context("Failed to create embeddings table")?;

        sqlx::query(embedding::CREATE_EMBEDDINGS_INDEXES)
            .execute(&self.pool)
            .await
            .context("Failed to create embeddings indexes")?;

        // Continue with remaining migrations
        let remaining_migrations = [
            component::CREATE_COMPONENTS_TABLE,
            component::CREATE_COMPONENTS_INDEXES,
            participant::CREATE_PARTICIPANTS_TABLE,
            participant::CREATE_PARTICIPANTS_INDEXES,
            relationship::CREATE_RELATIONSHIPS_TABLE,
            relationship::CREATE_RELATIONSHIPS_INDEXES,
            task::CREATE_TASKS_TABLE,
            task::CREATE_TASKS_INDEXES,
            log::CREATE_LOGS_TABLE,
            log::CREATE_LOGS_INDEXES,
            cache::CREATE_CACHE_TABLE,
            cache::CREATE_CACHE_INDEXES,
        ];

        for migration in remaining_migrations {
            sqlx::query(migration)
                .execute(&self.pool)
                .await
                .context("Failed to run migration")?;
        }

        info!("Database migrations completed successfully");
        Ok(())
    }
}
