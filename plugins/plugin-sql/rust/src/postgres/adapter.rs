#![allow(missing_docs)]
//! PostgreSQL adapter implementation for elizaOS

use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::Row;

use crate::base::*;
use crate::schema::*;
use elizaos::{
    Agent, Component, Entity, GetMemoriesParams, Log, Memory, Relationship, Room,
    SearchMemoriesParams, Task, World, UUID,
};

use super::PostgresConnectionManager;

/// PostgreSQL database adapter
pub struct PostgresAdapter {
    manager: PostgresConnectionManager,
    agent_id: uuid::Uuid,
    embedding_dimension: i32,
}

impl PostgresAdapter {
    /// Create a new PostgreSQL adapter
    pub async fn new(connection_string: &str, agent_id: &UUID) -> Result<Self> {
        let manager = PostgresConnectionManager::new(connection_string).await?;
        let agent_uuid = uuid::Uuid::parse_str(agent_id.as_str()).context("Invalid agent ID")?;

        Ok(PostgresAdapter {
            manager,
            agent_id: agent_uuid,
            embedding_dimension: embedding::DEFAULT_DIMENSION,
        })
    }

    /// Get the connection manager
    pub fn manager(&self) -> &PostgresConnectionManager {
        &self.manager
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl DatabaseAdapter for PostgresAdapter {
    async fn init(&self) -> Result<()> {
        self.manager.run_migrations().await
    }

    async fn is_ready(&self) -> Result<bool> {
        self.manager.test_connection().await
    }

    async fn close(&self) -> Result<()> {
        self.manager.close().await;
        Ok(())
    }

    async fn get_connection(&self) -> Result<DatabaseConnection> {
        Ok(DatabaseConnection::Postgres(self.manager.get_pool().clone()))
    }

    // =========================================================================
    // Agent Methods
    // =========================================================================

    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>> {
        let id = uuid::Uuid::parse_str(agent_id.as_str())?;

        let row = sqlx::query(
            r#"
            SELECT id, enabled, server_id, created_at, updated_at, name, username,
                   system, bio, message_examples, post_examples, topics, adjectives,
                   knowledge, plugins, settings, style
            FROM agents WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.map(|r| {
            let record = AgentRecord {
                id: r.get("id"),
                enabled: r.get("enabled"),
                server_id: r.get("server_id"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
                name: r.get("name"),
                username: r.get("username"),
                system: r.get("system"),
                bio: r.get("bio"),
                message_examples: r.get("message_examples"),
                post_examples: r.get("post_examples"),
                topics: r.get("topics"),
                adjectives: r.get("adjectives"),
                knowledge: r.get("knowledge"),
                plugins: r.get("plugins"),
                settings: r.get("settings"),
                style: r.get("style"),
            };
            record.to_agent()
        }))
    }

    async fn get_agents(&self) -> Result<Vec<Agent>> {
        let rows = sqlx::query(
            r#"
            SELECT id, enabled, server_id, created_at, updated_at, name, username,
                   system, bio, message_examples, post_examples, topics, adjectives,
                   knowledge, plugins, settings, style
            FROM agents
            "#,
        )
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let record = AgentRecord {
                    id: r.get("id"),
                    enabled: r.get("enabled"),
                    server_id: r.get("server_id"),
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                    name: r.get("name"),
                    username: r.get("username"),
                    system: r.get("system"),
                    bio: r.get("bio"),
                    message_examples: r.get("message_examples"),
                    post_examples: r.get("post_examples"),
                    topics: r.get("topics"),
                    adjectives: r.get("adjectives"),
                    knowledge: r.get("knowledge"),
                    plugins: r.get("plugins"),
                    settings: r.get("settings"),
                    style: r.get("style"),
                };
                record.to_agent()
            })
            .collect())
    }

    async fn create_agent(&self, agent: &Agent) -> Result<bool> {
        let id = agent
            .character
            .id
            .as_ref()
            .map(|u| uuid::Uuid::parse_str(u.as_str()).unwrap())
            .unwrap_or_else(uuid::Uuid::new_v4);

        let bio = serde_json::to_value(&agent.character.bio)?;
        let message_examples = serde_json::to_value(&agent.character.message_examples)?;
        let post_examples = serde_json::to_value(&agent.character.post_examples)?;
        let topics = serde_json::to_value(&agent.character.topics)?;
        let adjectives = serde_json::to_value(&agent.character.adjectives)?;
        let knowledge = serde_json::to_value(&agent.character.knowledge)?;
        let plugins = serde_json::to_value(&agent.character.plugins)?;
        let settings = serde_json::to_value(&agent.character.settings)?;
        let style = serde_json::to_value(&agent.character.style)?;

        sqlx::query(
            r#"
            INSERT INTO agents (id, enabled, name, username, system, bio, message_examples,
                               post_examples, topics, adjectives, knowledge, plugins, settings, style)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (id) DO NOTHING
            "#
        )
        .bind(id)
        .bind(agent.enabled.unwrap_or(true))
        .bind(&agent.character.name)
        .bind(&agent.character.username)
        .bind(&agent.character.system)
        .bind(bio)
        .bind(message_examples)
        .bind(post_examples)
        .bind(topics)
        .bind(adjectives)
        .bind(knowledge)
        .bind(plugins)
        .bind(settings)
        .bind(style)
        .execute(self.manager.get_pool())
        .await?;

        Ok(true)
    }

    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool> {
        let id = uuid::Uuid::parse_str(agent_id.as_str())?;
        let bio = serde_json::to_value(&agent.character.bio)?;
        let settings = serde_json::to_value(&agent.character.settings)?;

        sqlx::query(
            r#"
            UPDATE agents SET
                name = $2,
                username = $3,
                system = $4,
                bio = $5,
                settings = $6,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&agent.character.name)
        .bind(&agent.character.username)
        .bind(&agent.character.system)
        .bind(bio)
        .bind(settings)
        .execute(self.manager.get_pool())
        .await?;

        Ok(true)
    }

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool> {
        let id = uuid::Uuid::parse_str(agent_id.as_str())?;

        sqlx::query("DELETE FROM agents WHERE id = $1")
            .bind(id)
            .execute(self.manager.get_pool())
            .await?;

        Ok(true)
    }

    // =========================================================================
    // Entity Methods
    // =========================================================================

    async fn get_entities_by_ids(&self, entity_ids: &[UUID]) -> Result<Vec<Entity>> {
        let uuids: Vec<uuid::Uuid> = entity_ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.as_str()).ok())
            .collect();

        let rows = sqlx::query(
            r#"
            SELECT id, created_at, updated_at, names, metadata, agent_id
            FROM entities WHERE id = ANY($1)
            "#,
        )
        .bind(&uuids)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                EntityRecord {
                    id: r.get("id"),
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                    names: r.get("names"),
                    metadata: r.get("metadata"),
                    agent_id: r.get("agent_id"),
                }
                .to_entity()
            })
            .collect())
    }

    async fn get_entities_for_room(
        &self,
        room_id: &UUID,
        _include_components: bool,
    ) -> Result<Vec<Entity>> {
        let uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        let rows = sqlx::query(
            r#"
            SELECT e.id, e.created_at, e.updated_at, e.names, e.metadata, e.agent_id
            FROM entities e
            JOIN participants p ON e.id = p.entity_id
            WHERE p.room_id = $1
            "#,
        )
        .bind(uuid)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                EntityRecord {
                    id: r.get("id"),
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                    names: r.get("names"),
                    metadata: r.get("metadata"),
                    agent_id: r.get("agent_id"),
                }
                .to_entity()
            })
            .collect())
    }

    async fn create_entities(&self, entities: &[Entity]) -> Result<bool> {
        for entity in entities {
            let id = entity
                .id
                .as_ref()
                .map(|u| uuid::Uuid::parse_str(u.as_str()).unwrap())
                .unwrap_or_else(uuid::Uuid::new_v4);
            let agent_id = entity
                .agent_id
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Entity agent_id is required"))?;
            let agent_id = uuid::Uuid::parse_str(agent_id.as_str())?;
            let names = serde_json::to_value(&entity.names)?;
            let metadata = serde_json::to_value(&entity.metadata)?;

            sqlx::query(
                r#"
                INSERT INTO entities (id, agent_id, names, metadata)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (id) DO NOTHING
                "#,
            )
            .bind(id)
            .bind(agent_id)
            .bind(&names)
            .bind(&metadata)
            .execute(self.manager.get_pool())
            .await?;
        }
        Ok(true)
    }

    async fn update_entity(&self, entity: &Entity) -> Result<()> {
        let id = entity
            .id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Entity ID is required"))?;
        let uuid = uuid::Uuid::parse_str(id.as_str())?;
        let names = serde_json::to_value(&entity.names)?;
        let metadata = serde_json::to_value(&entity.metadata)?;

        sqlx::query(
            r#"
            UPDATE entities SET
                names = $2,
                metadata = $3,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(uuid)
        .bind(&names)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    // =========================================================================
    // Component Methods
    // =========================================================================

    async fn get_component(
        &self,
        entity_id: &UUID,
        component_type: &str,
        world_id: Option<&UUID>,
        source_entity_id: Option<&UUID>,
    ) -> Result<Option<Component>> {
        let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;
        let world_uuid = world_id
            .map(|id| uuid::Uuid::parse_str(id.as_str()))
            .transpose()?;
        let source_uuid = source_entity_id
            .map(|id| uuid::Uuid::parse_str(id.as_str()))
            .transpose()?;

        let mut query = String::from(
            r#"
            SELECT id, entity_id, agent_id, room_id, world_id, source_entity_id, type, data, created_at
            FROM components
            WHERE entity_id = $1 AND type = $2
            "#,
        );

        if world_uuid.is_some() {
            query.push_str(" AND world_id = $3");
        }
        if source_uuid.is_some() {
            query.push_str(if world_uuid.is_some() {
                " AND source_entity_id = $4"
            } else {
                " AND source_entity_id = $3"
            });
        }
        query.push_str(" LIMIT 1");

        let row = sqlx::query(&query)
            .bind(entity_uuid)
            .bind(component_type)
            .fetch_optional(self.manager.get_pool())
            .await?;

        Ok(row.map(|r| {
            ComponentRecord {
                id: r.get("id"),
                entity_id: r.get("entity_id"),
                agent_id: r.get("agent_id"),
                room_id: r.get("room_id"),
                world_id: r.get("world_id"),
                source_entity_id: r.get("source_entity_id"),
                component_type: r.get("type"),
                data: r.get("data"),
                created_at: r.get("created_at"),
            }
            .to_component()
        }))
    }

    async fn get_components(
        &self,
        entity_id: &UUID,
        world_id: Option<&UUID>,
        source_entity_id: Option<&UUID>,
    ) -> Result<Vec<Component>> {
        let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;

        let mut query = String::from(
            r#"
            SELECT id, entity_id, agent_id, room_id, world_id, source_entity_id, type, data, created_at
            FROM components
            WHERE entity_id = $1
            "#,
        );

        if world_id.is_some() {
            query.push_str(" AND world_id = $2");
        }
        if source_entity_id.is_some() {
            query.push_str(if world_id.is_some() {
                " AND source_entity_id = $3"
            } else {
                " AND source_entity_id = $2"
            });
        }

        let rows = sqlx::query(&query)
            .bind(entity_uuid)
            .fetch_all(self.manager.get_pool())
            .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                ComponentRecord {
                    id: r.get("id"),
                    entity_id: r.get("entity_id"),
                    agent_id: r.get("agent_id"),
                    room_id: r.get("room_id"),
                    world_id: r.get("world_id"),
                    source_entity_id: r.get("source_entity_id"),
                    component_type: r.get("type"),
                    data: r.get("data"),
                    created_at: r.get("created_at"),
                }
                .to_component()
            })
            .collect())
    }

    async fn create_component(&self, component: &Component) -> Result<bool> {
        let id =
            uuid::Uuid::parse_str(component.id.as_str()).unwrap_or_else(|_| uuid::Uuid::new_v4());
        let entity_id = uuid::Uuid::parse_str(component.entity_id.as_str())?;
        let agent_id = uuid::Uuid::parse_str(component.agent_id.as_str())?;
        let room_id = uuid::Uuid::parse_str(component.room_id.as_str())?;
        let world_id = component
            .world_id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Component world_id is required"))?;
        let world_id = uuid::Uuid::parse_str(world_id.as_str())?;
        let source_entity_id = component
            .source_entity_id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Component source_entity_id is required"))?;
        let source_entity_id = uuid::Uuid::parse_str(source_entity_id.as_str())?;
        let data = serde_json::to_value(&component.data)?;

        sqlx::query(
            r#"
            INSERT INTO components (id, entity_id, agent_id, room_id, world_id, source_entity_id, type, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(id)
        .bind(entity_id)
        .bind(agent_id)
        .bind(room_id)
        .bind(world_id)
        .bind(source_entity_id)
        .bind(&component.component_type)
        .bind(&data)
        .execute(self.manager.get_pool())
        .await?;

        Ok(true)
    }

    async fn update_component(&self, component: &Component) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(component.id.as_str())?;
        let data = serde_json::to_value(&component.data)?;

        sqlx::query(
            r#"
            UPDATE components SET data = $2 WHERE id = $1
            "#,
        )
        .bind(uuid)
        .bind(&data)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    async fn delete_component(&self, component_id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(component_id.as_str())?;

        sqlx::query("DELETE FROM components WHERE id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    // =========================================================================
    // Memory Methods
    // =========================================================================

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let mut qb = sqlx::QueryBuilder::new(
            r#"
            SELECT m.id, m.type, m.created_at, m.content, m.entity_id, m.agent_id,
                   m.room_id, m.world_id, m."unique", m.metadata
            FROM memories m
            WHERE m.type = "#,
        );

        qb.push_bind(&params.table_name);

        if let Some(entity_id) = params.entity_id.as_ref() {
            let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;
            qb.push(" AND m.entity_id = ").push_bind(entity_uuid);
        }

        if let Some(room_id) = params.room_id.as_ref() {
            let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;
            qb.push(" AND m.room_id = ").push_bind(room_uuid);
        }

        if let Some(agent_id) = params.agent_id.as_ref() {
            let agent_uuid = uuid::Uuid::parse_str(agent_id.as_str())?;
            qb.push(" AND m.agent_id = ").push_bind(agent_uuid);
        }

        if let Some(world_id) = params.world_id.as_ref() {
            let world_uuid = uuid::Uuid::parse_str(world_id.as_str())?;
            qb.push(" AND m.world_id = ").push_bind(world_uuid);
        }

        if params.unique.unwrap_or(false) {
            qb.push(r#" AND m."unique" = true"#);
        }

        if let Some(start) = params.start {
            let start_s = (start as f64) / 1000.0;
            qb.push(" AND m.created_at >= to_timestamp(")
                .push_bind(start_s)
                .push(")");
        }

        if let Some(end) = params.end {
            let end_s = (end as f64) / 1000.0;
            qb.push(" AND m.created_at <= to_timestamp(")
                .push_bind(end_s)
                .push(")");
        }

        qb.push(" ORDER BY m.created_at DESC");

        if let Some(count) = params.count {
            qb.push(" LIMIT ").push_bind(count);
        }

        if let Some(offset) = params.offset {
            qb.push(" OFFSET ").push_bind(offset);
        }

        let rows = qb.build().fetch_all(self.manager.get_pool()).await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                MemoryRecord {
                    id: r.get("id"),
                    memory_type: r.get("type"),
                    created_at: r.get("created_at"),
                    content: r.get("content"),
                    entity_id: r.get("entity_id"),
                    agent_id: r.get("agent_id"),
                    room_id: r.get("room_id"),
                    world_id: r.get("world_id"),
                    unique: r.get("unique"),
                    metadata: r.get("metadata"),
                }
                .to_memory()
            })
            .collect())
    }

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;

        let row = sqlx::query(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE id = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.map(|r| {
            MemoryRecord {
                id: r.get("id"),
                memory_type: r.get("type"),
                created_at: r.get("created_at"),
                content: r.get("content"),
                entity_id: r.get("entity_id"),
                agent_id: r.get("agent_id"),
                room_id: r.get("room_id"),
                world_id: r.get("world_id"),
                unique: r.get("unique"),
                metadata: r.get("metadata"),
            }
            .to_memory()
        }))
    }

    async fn get_memories_by_ids(
        &self,
        ids: &[UUID],
        _table_name: Option<&str>,
    ) -> Result<Vec<Memory>> {
        let uuids: Vec<uuid::Uuid> = ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.as_str()).ok())
            .collect();

        let rows = sqlx::query(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE id = ANY($1)
            "#,
        )
        .bind(&uuids)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                MemoryRecord {
                    id: r.get("id"),
                    memory_type: r.get("type"),
                    created_at: r.get("created_at"),
                    content: r.get("content"),
                    entity_id: r.get("entity_id"),
                    agent_id: r.get("agent_id"),
                    room_id: r.get("room_id"),
                    world_id: r.get("world_id"),
                    unique: r.get("unique"),
                    metadata: r.get("metadata"),
                }
                .to_memory()
            })
            .collect())
    }

    async fn get_memories_by_room_ids(
        &self,
        table_name: &str,
        room_ids: &[UUID],
        limit: Option<i32>,
    ) -> Result<Vec<Memory>> {
        let uuids: Vec<uuid::Uuid> = room_ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.as_str()).ok())
            .collect();

        let limit_str = limit.map(|l| format!(" LIMIT {}", l)).unwrap_or_default();

        let query = format!(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE type = $1 AND room_id = ANY($2)
            ORDER BY created_at DESC
            {}
            "#,
            limit_str
        );

        let rows = sqlx::query(&query)
            .bind(table_name)
            .bind(&uuids)
            .fetch_all(self.manager.get_pool())
            .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                MemoryRecord {
                    id: r.get("id"),
                    memory_type: r.get("type"),
                    created_at: r.get("created_at"),
                    content: r.get("content"),
                    entity_id: r.get("entity_id"),
                    agent_id: r.get("agent_id"),
                    room_id: r.get("room_id"),
                    world_id: r.get("world_id"),
                    unique: r.get("unique"),
                    metadata: r.get("metadata"),
                }
                .to_memory()
            })
            .collect())
    }

    async fn get_cached_embeddings(
        &self,
        params: GetCachedEmbeddingsParams,
    ) -> Result<Vec<EmbeddingSearchResult>> {
        let rows = sqlx::query(
            r#"
            SELECT e.id, e.embedding, m.content
            FROM embeddings e
            JOIN memories m ON e.id = m.id
            WHERE m.type = $1
            "#,
        )
        .bind(&params.table_name)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let embedding: Vec<f32> = r.get("embedding");
                EmbeddingSearchResult {
                    id: UUID::new(&r.get::<uuid::Uuid, _>("id").to_string()).unwrap(),
                    embedding,
                    similarity: None,
                }
            })
            .collect())
    }

    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        let threshold = params.match_threshold.unwrap_or(0.7);
        let count = params.count.unwrap_or(10);

        let query = embedding::search_embeddings_sql(self.embedding_dimension, count);

        let rows = sqlx::query(&query)
            .bind(&params.embedding)
            .bind(threshold)
            .fetch_all(self.manager.get_pool())
            .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let mut memory = MemoryRecord {
                    id: r.get("id"),
                    memory_type: r.get("type"),
                    created_at: r.get("created_at"),
                    content: r.get("content"),
                    entity_id: r.get("entity_id"),
                    agent_id: r.get("agent_id"),
                    room_id: r.get("room_id"),
                    world_id: r.get("world_id"),
                    unique: r.get("unique"),
                    metadata: r.get("metadata"),
                }
                .to_memory();

                memory.similarity = r.try_get("similarity").ok();
                memory
            })
            .collect())
    }

    async fn create_memory(
        &self,
        memory: &Memory,
        table_name: &str,
        _unique: bool,
    ) -> Result<UUID> {
        let record = MemoryRecord::from_memory(memory, table_name);

        sqlx::query(
            r#"
            INSERT INTO memories (id, type, content, entity_id, agent_id, room_id, world_id, "unique", metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#
        )
        .bind(record.id)
        .bind(&record.memory_type)
        .bind(&record.content)
        .bind(record.entity_id)
        .bind(record.agent_id)
        .bind(record.room_id)
        .bind(record.world_id)
        .bind(record.unique)
        .bind(&record.metadata)
        .execute(self.manager.get_pool())
        .await?;

        // If memory has embedding, store it
        if let Some(embedding) = &memory.embedding {
            sqlx::query(
                r#"
                INSERT INTO embeddings (id, embedding)
                VALUES ($1, $2::vector)
                "#,
            )
            .bind(record.id)
            .bind(embedding)
            .execute(self.manager.get_pool())
            .await?;
        }

        Ok(UUID::new(&record.id.to_string()).unwrap())
    }

    async fn update_memory(&self, memory: &Memory) -> Result<bool> {
        let id = memory
            .id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Memory ID is required"))?;
        let uuid = uuid::Uuid::parse_str(id.as_str())?;
        let content = serde_json::to_value(&memory.content)?;
        let metadata = serde_json::to_value(&memory.metadata)?;

        sqlx::query(
            r#"
            UPDATE memories SET
                content = $2,
                metadata = $3
            WHERE id = $1
            "#,
        )
        .bind(uuid)
        .bind(&content)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(true)
    }

    async fn delete_memory(&self, memory_id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(memory_id.as_str())?;

        sqlx::query("DELETE FROM memories WHERE id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    async fn delete_many_memories(&self, memory_ids: &[UUID]) -> Result<()> {
        let uuids: Vec<uuid::Uuid> = memory_ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.as_str()).ok())
            .collect();

        sqlx::query("DELETE FROM memories WHERE id = ANY($1)")
            .bind(&uuids)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    async fn delete_all_memories(&self, room_id: &UUID, table_name: &str) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        sqlx::query("DELETE FROM memories WHERE room_id = $1 AND type = $2")
            .bind(uuid)
            .bind(table_name)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    async fn count_memories(
        &self,
        room_id: &UUID,
        _unique: bool,
        table_name: Option<&str>,
    ) -> Result<i64> {
        let uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        let count = if let Some(table) = table_name {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM memories WHERE room_id = $1 AND type = $2",
            )
            .bind(uuid)
            .bind(table)
            .fetch_one(self.manager.get_pool())
            .await?
        } else {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memories WHERE room_id = $1")
                .bind(uuid)
                .fetch_one(self.manager.get_pool())
                .await?
        };

        Ok(count)
    }

    async fn ensure_embedding_dimension(&self, dimension: i32) -> Result<()> {
        if dimension != self.embedding_dimension {
            sqlx::query("DROP TABLE IF EXISTS embeddings")
                .execute(self.manager.get_pool())
                .await?;

            sqlx::query(&embedding::create_embeddings_table_sql(dimension))
                .execute(self.manager.get_pool())
                .await?;

            sqlx::query(embedding::CREATE_EMBEDDINGS_INDEXES)
                .execute(self.manager.get_pool())
                .await?;
        }

        Ok(())
    }

    async fn get_memories_by_world_id(
        &self,
        world_id: &UUID,
        count: Option<i32>,
        table_name: Option<&str>,
    ) -> Result<Vec<Memory>> {
        let uuid = uuid::Uuid::parse_str(world_id.as_str())?;
        let limit = count.map(|c| format!(" LIMIT {}", c)).unwrap_or_default();

        let query = if let Some(_table) = table_name {
            format!(
                r#"
                SELECT id, type, created_at, content, entity_id, agent_id,
                       room_id, world_id, "unique", metadata
                FROM memories WHERE world_id = $1 AND type = $2
                ORDER BY created_at DESC
                {}
                "#,
                limit
            )
        } else {
            format!(
                r#"
                SELECT id, type, created_at, content, entity_id, agent_id,
                       room_id, world_id, "unique", metadata
                FROM memories WHERE world_id = $1
                ORDER BY created_at DESC
                {}
                "#,
                limit
            )
        };

        let rows = if let Some(table) = table_name {
            sqlx::query(&query)
                .bind(uuid)
                .bind(table)
                .fetch_all(self.manager.get_pool())
                .await?
        } else {
            sqlx::query(&query)
                .bind(uuid)
                .fetch_all(self.manager.get_pool())
                .await?
        };

        Ok(rows
            .into_iter()
            .map(|r| {
                MemoryRecord {
                    id: r.get("id"),
                    memory_type: r.get("type"),
                    created_at: r.get("created_at"),
                    content: r.get("content"),
                    entity_id: r.get("entity_id"),
                    agent_id: r.get("agent_id"),
                    room_id: r.get("room_id"),
                    world_id: r.get("world_id"),
                    unique: r.get("unique"),
                    metadata: r.get("metadata"),
                }
                .to_memory()
            })
            .collect())
    }

    // =========================================================================
    // Log Methods
    // =========================================================================

    async fn log(&self, params: LogParams) -> Result<()> {
        let entity_id = uuid::Uuid::parse_str(params.entity_id.as_str())?;
        let room_id = params
            .room_id
            .as_ref()
            .map(|r| uuid::Uuid::parse_str(r.as_str()))
            .transpose()?;
        let body = serde_json::to_value(&params.body)?;

        sqlx::query(
            r#"
            INSERT INTO logs (id, entity_id, room_id, type, body)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(uuid::Uuid::new_v4())
        .bind(entity_id)
        .bind(room_id)
        .bind(&params.log_type)
        .bind(&body)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    async fn get_logs(&self, params: GetLogsParams) -> Result<Vec<Log>> {
        let mut qb = sqlx::QueryBuilder::new(
            r#"
            SELECT id, entity_id, room_id, type, body, created_at
            FROM logs WHERE 1=1
            "#,
        );

        if let Some(entity_id) = params.entity_id.as_ref() {
            let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;
            qb.push(" AND entity_id = ").push_bind(entity_uuid);
        }
        if let Some(room_id) = params.room_id.as_ref() {
            let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;
            qb.push(" AND room_id = ").push_bind(room_uuid);
        }
        if let Some(log_type) = params.log_type.as_ref() {
            qb.push(" AND type = ").push_bind(log_type);
        }

        qb.push(" ORDER BY created_at DESC");

        if let Some(count) = params.count {
            qb.push(" LIMIT ").push_bind(count);
        }

        if let Some(offset) = params.offset {
            qb.push(" OFFSET ").push_bind(offset);
        }

        let rows = qb.build().fetch_all(self.manager.get_pool()).await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                LogRecord {
                    id: r.get("id"),
                    entity_id: r.get("entity_id"),
                    room_id: r.get("room_id"),
                    log_type: r.get("type"),
                    body: r.get("body"),
                    created_at: r.get("created_at"),
                }
                .to_log()
            })
            .collect())
    }

    async fn delete_log(&self, log_id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(log_id.as_str())?;

        sqlx::query("DELETE FROM logs WHERE id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    // =========================================================================
    // World Methods
    // =========================================================================

    async fn create_world(&self, world: &World) -> Result<UUID> {
        let id = uuid::Uuid::parse_str(world.id.as_str())?;
        let agent_id = uuid::Uuid::parse_str(world.agent_id.as_str())?;
        let metadata = serde_json::to_value(&world.metadata)?;

        sqlx::query(
            r#"
            INSERT INTO worlds (id, name, agent_id, message_server_id, metadata)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(id)
        .bind(&world.name)
        .bind(agent_id)
        .bind(
            world
                .message_server_id
                .as_ref()
                .and_then(|u| uuid::Uuid::parse_str(u.as_str()).ok()),
        )
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(world.id.clone())
    }

    async fn get_world(&self, id: &UUID) -> Result<Option<World>> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;

        let row = sqlx::query(
            "SELECT id, created_at, name, agent_id, message_server_id, metadata FROM worlds WHERE id = $1",
        )
        .bind(uuid)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.map(|r| {
            WorldRecord {
                id: r.get("id"),
                created_at: r.get("created_at"),
                name: r.get("name"),
                agent_id: r.get("agent_id"),
                message_server_id: r.get("message_server_id"),
                metadata: r.get("metadata"),
            }
            .to_world()
        }))
    }

    async fn remove_world(&self, id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;
        sqlx::query("DELETE FROM worlds WHERE id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;
        Ok(())
    }

    async fn get_all_worlds(&self) -> Result<Vec<World>> {
        let rows = sqlx::query(
            "SELECT id, created_at, name, agent_id, message_server_id, metadata FROM worlds",
        )
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                WorldRecord {
                    id: r.get("id"),
                    created_at: r.get("created_at"),
                    name: r.get("name"),
                    agent_id: r.get("agent_id"),
                    message_server_id: r.get("message_server_id"),
                    metadata: r.get("metadata"),
                }
                .to_world()
            })
            .collect())
    }

    async fn update_world(&self, world: &World) -> Result<()> {
        let id = uuid::Uuid::parse_str(world.id.as_str())?;
        let metadata = serde_json::to_value(&world.metadata)?;

        sqlx::query(
            r#"
            UPDATE worlds SET name = $2, metadata = $3 WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&world.name)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    // =========================================================================
    // Room Methods
    // =========================================================================

    async fn get_rooms_by_ids(&self, room_ids: &[UUID]) -> Result<Vec<Room>> {
        let uuids: Vec<uuid::Uuid> = room_ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.as_str()).ok())
            .collect();

        let rows = sqlx::query(
            r#"
            SELECT id, created_at, name, agent_id, source, type, channel_id, message_server_id, world_id, metadata
            FROM rooms WHERE id = ANY($1)
            "#,
        )
        .bind(&uuids)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                RoomRecord {
                    id: r.get("id"),
                    created_at: r.get("created_at"),
                    name: r.get("name"),
                    agent_id: r.get("agent_id"),
                    source: r.get("source"),
                    room_type: r.get("type"),
                    channel_id: r.get("channel_id"),
                    message_server_id: r.get("message_server_id"),
                    world_id: r.get("world_id"),
                    metadata: r.get("metadata"),
                }
                .to_room()
            })
            .collect())
    }

    async fn create_rooms(&self, rooms: &[Room]) -> Result<Vec<UUID>> {
        let mut created_ids = Vec::new();

        for room in rooms {
            let id = uuid::Uuid::parse_str(room.id.as_str())?;
            let agent_id = room
                .agent_id
                .as_ref()
                .map(|u| uuid::Uuid::parse_str(u.as_str()))
                .transpose()?;
            let world_id = room
                .world_id
                .as_ref()
                .map(|u| uuid::Uuid::parse_str(u.as_str()))
                .transpose()?;
            let metadata = serde_json::to_value(&room.metadata)?;

            sqlx::query(
                r#"
                INSERT INTO rooms (id, name, agent_id, source, type, channel_id, message_server_id, world_id, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING
                "#,
            )
            .bind(id)
            .bind(&room.name)
            .bind(agent_id)
            .bind(&room.source)
            .bind(room.room_type.as_str())
            .bind(&room.channel_id)
            .bind(room.message_server_id.as_ref().and_then(|u| uuid::Uuid::parse_str(u.as_str()).ok()))
            .bind(world_id)
            .bind(&metadata)
            .execute(self.manager.get_pool())
            .await?;

            created_ids.push(room.id.clone());
        }

        Ok(created_ids)
    }

    async fn delete_room(&self, room_id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        sqlx::query("DELETE FROM rooms WHERE id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    async fn delete_rooms_by_world_id(&self, world_id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(world_id.as_str())?;

        sqlx::query("DELETE FROM rooms WHERE world_id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }

    async fn update_room(&self, room: &Room) -> Result<()> {
        let id = uuid::Uuid::parse_str(room.id.as_str())?;
        let metadata = serde_json::to_value(&room.metadata)?;

        sqlx::query(
            r#"
            UPDATE rooms SET name = $2, metadata = $3 WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&room.name)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    async fn get_rooms_by_world(&self, world_id: &UUID) -> Result<Vec<Room>> {
        let uuid = uuid::Uuid::parse_str(world_id.as_str())?;

        let rows = sqlx::query(
            r#"
            SELECT id, created_at, name, agent_id, source, type, channel_id, message_server_id, world_id, metadata
            FROM rooms WHERE world_id = $1
            "#,
        )
        .bind(uuid)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                RoomRecord {
                    id: r.get("id"),
                    created_at: r.get("created_at"),
                    name: r.get("name"),
                    agent_id: r.get("agent_id"),
                    source: r.get("source"),
                    room_type: r.get("type"),
                    channel_id: r.get("channel_id"),
                    message_server_id: r.get("message_server_id"),
                    world_id: r.get("world_id"),
                    metadata: r.get("metadata"),
                }
                .to_room()
            })
            .collect())
    }

    // =========================================================================
    // Participant Methods
    // =========================================================================

    async fn get_rooms_for_participant(&self, entity_id: &UUID) -> Result<Vec<UUID>> {
        let uuid = uuid::Uuid::parse_str(entity_id.as_str())?;

        let rows = sqlx::query("SELECT room_id FROM participants WHERE entity_id = $1")
            .bind(uuid)
            .fetch_all(self.manager.get_pool())
            .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let room_id: uuid::Uuid = r.get("room_id");
                UUID::new(&room_id.to_string()).unwrap()
            })
            .collect())
    }

    async fn get_rooms_for_participants(&self, user_ids: &[UUID]) -> Result<Vec<UUID>> {
        let uuids: Vec<uuid::Uuid> = user_ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.as_str()).ok())
            .collect();

        let rows =
            sqlx::query("SELECT DISTINCT room_id FROM participants WHERE entity_id = ANY($1)")
                .bind(&uuids)
                .fetch_all(self.manager.get_pool())
                .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let room_id: uuid::Uuid = r.get("room_id");
                UUID::new(&room_id.to_string()).unwrap()
            })
            .collect())
    }

    async fn remove_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool> {
        let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;
        let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        sqlx::query("DELETE FROM participants WHERE entity_id = $1 AND room_id = $2")
            .bind(entity_uuid)
            .bind(room_uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(true)
    }

    async fn get_participants_for_entity(&self, entity_id: &UUID) -> Result<Vec<ParticipantInfo>> {
        let uuid = uuid::Uuid::parse_str(entity_id.as_str())?;

        let rows = sqlx::query(
            r#"
            SELECT id, entity_id, room_id, user_state, created_at
            FROM participants WHERE entity_id = $1
            "#,
        )
        .bind(uuid)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                ParticipantRecord {
                    id: r.get("id"),
                    entity_id: r.get("entity_id"),
                    room_id: r.get("room_id"),
                    user_state: r.get("user_state"),
                    created_at: r.get("created_at"),
                }
                .to_participant_info()
            })
            .collect())
    }

    async fn get_participants_for_room(&self, room_id: &UUID) -> Result<Vec<UUID>> {
        let uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        let rows = sqlx::query("SELECT entity_id FROM participants WHERE room_id = $1")
            .bind(uuid)
            .fetch_all(self.manager.get_pool())
            .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let entity_id: uuid::Uuid = r.get("entity_id");
                UUID::new(&entity_id.to_string()).unwrap()
            })
            .collect())
    }

    async fn is_room_participant(&self, room_id: &UUID, entity_id: &UUID) -> Result<bool> {
        let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;
        let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM participants WHERE room_id = $1 AND entity_id = $2",
        )
        .bind(room_uuid)
        .bind(entity_uuid)
        .fetch_one(self.manager.get_pool())
        .await?;

        Ok(count > 0)
    }

    async fn add_participants_room(&self, entity_ids: &[UUID], room_id: &UUID) -> Result<bool> {
        let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;

        for entity_id in entity_ids {
            let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;

            sqlx::query(
                r#"
                INSERT INTO participants (id, entity_id, room_id)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
                "#,
            )
            .bind(uuid::Uuid::new_v4())
            .bind(entity_uuid)
            .bind(room_uuid)
            .execute(self.manager.get_pool())
            .await?;
        }

        Ok(true)
    }

    async fn get_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
    ) -> Result<Option<ParticipantUserState>> {
        let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;
        let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;

        let row = sqlx::query(
            "SELECT user_state FROM participants WHERE room_id = $1 AND entity_id = $2",
        )
        .bind(room_uuid)
        .bind(entity_uuid)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.and_then(|r| {
            let state: Option<String> = r.get("user_state");
            state.map(|s| ParticipantUserState { state: s })
        }))
    }

    async fn set_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
        state: Option<ParticipantUserState>,
    ) -> Result<()> {
        let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;
        let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;
        let state_str = state.map(|s| s.state);

        sqlx::query(
            r#"
            UPDATE participants SET user_state = $3 WHERE room_id = $1 AND entity_id = $2
            "#,
        )
        .bind(room_uuid)
        .bind(entity_uuid)
        .bind(state_str)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    // =========================================================================
    // Relationship Methods
    // =========================================================================

    async fn create_relationship(&self, params: CreateRelationshipParams) -> Result<bool> {
        let source_id = uuid::Uuid::parse_str(params.source_entity_id.as_str())?;
        let target_id = uuid::Uuid::parse_str(params.target_entity_id.as_str())?;
        let tags = serde_json::to_value(&params.tags)?;
        let metadata = serde_json::to_value(&params.metadata)?;

        sqlx::query(
            r#"
            INSERT INTO relationships (id, source_entity_id, target_entity_id, agent_id, tags, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(uuid::Uuid::new_v4())
        .bind(source_id)
        .bind(target_id)
        .bind(self.agent_id)
        .bind(&tags)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(true)
    }

    async fn update_relationship(&self, relationship: &Relationship) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(relationship.id.as_str())?;
        let tags = serde_json::to_value(&relationship.tags)?;
        let metadata = serde_json::to_value(&relationship.metadata)?;

        sqlx::query(
            r#"
            UPDATE relationships SET tags = $2, metadata = $3 WHERE id = $1
            "#,
        )
        .bind(uuid)
        .bind(&tags)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    async fn get_relationship(
        &self,
        params: GetRelationshipParams,
    ) -> Result<Option<Relationship>> {
        let source_id = uuid::Uuid::parse_str(params.source_entity_id.as_str())?;
        let target_id = uuid::Uuid::parse_str(params.target_entity_id.as_str())?;

        let row = sqlx::query(
            r#"
            SELECT id, source_entity_id, target_entity_id, agent_id, tags, metadata, created_at
            FROM relationships
            WHERE source_entity_id = $1 AND target_entity_id = $2
            "#,
        )
        .bind(source_id)
        .bind(target_id)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.map(|r| {
            RelationshipRecord {
                id: r.get("id"),
                source_entity_id: r.get("source_entity_id"),
                target_entity_id: r.get("target_entity_id"),
                agent_id: r.get("agent_id"),
                tags: r.get("tags"),
                metadata: r.get("metadata"),
                created_at: r.get("created_at"),
            }
            .to_relationship()
        }))
    }

    async fn get_relationships(&self, params: GetRelationshipsParams) -> Result<Vec<Relationship>> {
        let entity_id = uuid::Uuid::parse_str(params.entity_id.as_str())?;

        let rows = sqlx::query(
            r#"
            SELECT id, source_entity_id, target_entity_id, agent_id, tags, metadata, created_at
            FROM relationships
            WHERE source_entity_id = $1 OR target_entity_id = $1
            "#,
        )
        .bind(entity_id)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                RelationshipRecord {
                    id: r.get("id"),
                    source_entity_id: r.get("source_entity_id"),
                    target_entity_id: r.get("target_entity_id"),
                    agent_id: r.get("agent_id"),
                    tags: r.get("tags"),
                    metadata: r.get("metadata"),
                    created_at: r.get("created_at"),
                }
                .to_relationship()
            })
            .collect())
    }

    // =========================================================================
    // Cache Methods
    // =========================================================================

    async fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let row = sqlx::query("SELECT value, expires_at FROM cache WHERE key = $1")
            .bind(key)
            .fetch_optional(self.manager.get_pool())
            .await?;

        if let Some(r) = row {
            let expires_at: Option<chrono::DateTime<chrono::Utc>> = r.get("expires_at");
            if let Some(exp) = expires_at {
                if exp < chrono::Utc::now() {
                    self.delete_cache(key).await?;
                    return Ok(None);
                }
            }
            let value: serde_json::Value = r.get("value");
            Ok(Some(serde_json::from_value(value)?))
        } else {
            Ok(None)
        }
    }

    async fn set_cache<T: serde::Serialize + Send + Sync>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<bool> {
        let json = serde_json::to_value(value)?;

        sqlx::query(
            r#"
            INSERT INTO cache (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = $2
            "#,
        )
        .bind(key)
        .bind(&json)
        .execute(self.manager.get_pool())
        .await?;

        Ok(true)
    }

    async fn delete_cache(&self, key: &str) -> Result<bool> {
        sqlx::query("DELETE FROM cache WHERE key = $1")
            .bind(key)
            .execute(self.manager.get_pool())
            .await?;
        Ok(true)
    }

    // =========================================================================
    // Task Methods
    // =========================================================================

    async fn create_task(&self, task: &Task) -> Result<UUID> {
        let id = task
            .id
            .as_ref()
            .map(|u| uuid::Uuid::parse_str(u.as_str()).unwrap())
            .unwrap_or_else(uuid::Uuid::new_v4);
        let room_id = task
            .room_id
            .as_ref()
            .map(|u| uuid::Uuid::parse_str(u.as_str()))
            .transpose()?;
        let entity_id = task
            .entity_id
            .as_ref()
            .map(|u| uuid::Uuid::parse_str(u.as_str()))
            .transpose()?;
        let world_id = task
            .world_id
            .as_ref()
            .map(|u| uuid::Uuid::parse_str(u.as_str()))
            .transpose()?;
        let tags = serde_json::to_value(&task.tags)?;
        let metadata = serde_json::to_value(&task.metadata)?;

        sqlx::query(
            r#"
            INSERT INTO tasks (id, name, description, room_id, entity_id, world_id, status, tags, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(id)
        .bind(&task.name)
        .bind(&task.description)
        .bind(room_id)
        .bind(entity_id)
        .bind(world_id)
        .bind(task.status.as_ref().map(|s| s.as_str()))
        .bind(&tags)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(UUID::new(&id.to_string()).unwrap())
    }

    async fn get_tasks(&self, params: GetTasksParams) -> Result<Vec<Task>> {
        let mut qb = sqlx::QueryBuilder::new(
            r#"
            SELECT id, name, description, room_id, entity_id, world_id, status, tags, metadata, created_at, updated_at
            FROM tasks WHERE 1=1
            "#,
        );

        if let Some(room_id) = params.room_id.as_ref() {
            let room_uuid = uuid::Uuid::parse_str(room_id.as_str())?;
            qb.push(" AND room_id = ").push_bind(room_uuid);
        }

        if let Some(entity_id) = params.entity_id.as_ref() {
            let entity_uuid = uuid::Uuid::parse_str(entity_id.as_str())?;
            qb.push(" AND entity_id = ").push_bind(entity_uuid);
        }

        let rows = qb.build().fetch_all(self.manager.get_pool()).await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                TaskRecord {
                    id: r.get("id"),
                    name: r.get("name"),
                    description: r.get("description"),
                    room_id: r.get("room_id"),
                    entity_id: r.get("entity_id"),
                    world_id: r.get("world_id"),
                    status: r.get("status"),
                    tags: r.get("tags"),
                    metadata: r.get("metadata"),
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                    scheduled_at: r.try_get("scheduled_at").ok().flatten(),
                    repeat_interval: r.try_get("repeat_interval").ok().flatten(),
                    data: r.try_get("data").ok().flatten(),
                }
                .to_task()
            })
            .collect())
    }

    async fn get_task(&self, id: &UUID) -> Result<Option<Task>> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;

        let row = sqlx::query(
            r#"
            SELECT id, name, description, room_id, entity_id, world_id, status, tags, metadata, created_at, updated_at
            FROM tasks WHERE id = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.map(|r| {
            TaskRecord {
                id: r.get("id"),
                name: r.get("name"),
                description: r.get("description"),
                room_id: r.get("room_id"),
                entity_id: r.get("entity_id"),
                world_id: r.get("world_id"),
                status: r.get("status"),
                tags: r.get("tags"),
                metadata: r.get("metadata"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
                scheduled_at: r.try_get("scheduled_at").ok().flatten(),
                repeat_interval: r.try_get("repeat_interval").ok().flatten(),
                data: r.try_get("data").ok().flatten(),
            }
            .to_task()
        }))
    }

    async fn get_tasks_by_name(&self, name: &str) -> Result<Vec<Task>> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, description, room_id, entity_id, world_id, status, tags, metadata, created_at, updated_at
            FROM tasks WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_all(self.manager.get_pool())
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                TaskRecord {
                    id: r.get("id"),
                    name: r.get("name"),
                    description: r.get("description"),
                    room_id: r.get("room_id"),
                    entity_id: r.get("entity_id"),
                    world_id: r.get("world_id"),
                    status: r.get("status"),
                    tags: r.get("tags"),
                    metadata: r.get("metadata"),
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                    scheduled_at: r.try_get("scheduled_at").ok().flatten(),
                    repeat_interval: r.try_get("repeat_interval").ok().flatten(),
                    data: r.try_get("data").ok().flatten(),
                }
                .to_task()
            })
            .collect())
    }

    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;
        let tags = serde_json::to_value(&task.tags)?;
        let metadata = serde_json::to_value(&task.metadata)?;

        sqlx::query(
            r#"
            UPDATE tasks SET
                status = $2,
                tags = $3,
                metadata = $4,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(uuid)
        .bind(task.status.as_ref().map(|s| s.as_str()))
        .bind(&tags)
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(())
    }

    async fn delete_task(&self, id: &UUID) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;

        sqlx::query("DELETE FROM tasks WHERE id = $1")
            .bind(uuid)
            .execute(self.manager.get_pool())
            .await?;

        Ok(())
    }
}
