//! PostgreSQL adapter implementation for elizaOS

use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::Row;
use tracing::{debug, error};

use crate::base::*;
use crate::schema::*;
use elizaos_core::{
    Agent, Component, Entity, GetMemoriesParams, Log, Memory, Metadata, Participant, Relationship,
    Room, SearchMemoriesParams, Task, World, UUID,
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

#[async_trait]
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

    async fn get_connection(&self) -> Result<Box<dyn std::any::Any + Send>> {
        Ok(Box::new(self.manager.get_pool().clone()))
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
    // Memory Methods
    // =========================================================================

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let mut query = String::from(
            r#"
            SELECT m.id, m.type, m.created_at, m.content, m.entity_id, m.agent_id,
                   m.room_id, m.world_id, m.unique, m.metadata
            FROM memories m
            WHERE m.type = $1
            "#,
        );

        let mut bindings: Vec<Box<dyn sqlx::Encode<'_, sqlx::Postgres> + Send + Sync>> =
            vec![Box::new(params.table_name.clone())];
        let mut param_count = 1;

        if let Some(room_id) = &params.room_id {
            param_count += 1;
            query.push_str(&format!(" AND m.room_id = ${}", param_count));
        }

        if let Some(agent_id) = &params.agent_id {
            param_count += 1;
            query.push_str(&format!(" AND m.agent_id = ${}", param_count));
        }

        query.push_str(" ORDER BY m.created_at DESC");

        if let Some(count) = params.count {
            query.push_str(&format!(" LIMIT {}", count));
        }

        if let Some(offset) = params.offset {
            query.push_str(&format!(" OFFSET {}", offset));
        }

        let rows = sqlx::query(&query)
            .bind(&params.table_name)
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
        _params: GetCachedEmbeddingsParams,
    ) -> Result<Vec<EmbeddingSearchResult>> {
        // TODO: Implement cached embeddings query
        Ok(vec![])
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

        let query = if let Some(table) = table_name {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM memories WHERE room_id = $1 AND type = $2",
            )
            .bind(uuid)
            .bind(table)
        } else {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memories WHERE room_id = $1")
                .bind(uuid)
        };

        let count = query.fetch_one(self.manager.get_pool()).await?;
        Ok(count)
    }

    async fn ensure_embedding_dimension(&self, dimension: i32) -> Result<()> {
        // Re-create embeddings table with new dimension if needed
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

        let query = if let Some(table) = table_name {
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

        let rows = if table_name.is_some() {
            sqlx::query(&query)
                .bind(uuid)
                .bind(table_name.unwrap())
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

    // Stub implementations for remaining methods
    async fn get_entities_by_ids(&self, _entity_ids: &[UUID]) -> Result<Vec<Entity>> {
        Ok(vec![])
    }

    async fn get_entities_for_room(
        &self,
        _room_id: &UUID,
        _include_components: bool,
    ) -> Result<Vec<Entity>> {
        Ok(vec![])
    }

    async fn create_entities(&self, _entities: &[Entity]) -> Result<bool> {
        Ok(true)
    }

    async fn update_entity(&self, _entity: &Entity) -> Result<()> {
        Ok(())
    }

    async fn get_component(
        &self,
        _entity_id: &UUID,
        _component_type: &str,
        _world_id: Option<&UUID>,
        _source_entity_id: Option<&UUID>,
    ) -> Result<Option<Component>> {
        Ok(None)
    }

    async fn get_components(
        &self,
        _entity_id: &UUID,
        _world_id: Option<&UUID>,
        _source_entity_id: Option<&UUID>,
    ) -> Result<Vec<Component>> {
        Ok(vec![])
    }

    async fn create_component(&self, _component: &Component) -> Result<bool> {
        Ok(true)
    }

    async fn update_component(&self, _component: &Component) -> Result<()> {
        Ok(())
    }

    async fn delete_component(&self, _component_id: &UUID) -> Result<()> {
        Ok(())
    }

    async fn log(&self, _params: LogParams) -> Result<()> {
        Ok(())
    }

    async fn get_logs(&self, _params: GetLogsParams) -> Result<Vec<Log>> {
        Ok(vec![])
    }

    async fn delete_log(&self, _log_id: &UUID) -> Result<()> {
        Ok(())
    }

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
                .map(|u| uuid::Uuid::parse_str(u.as_str()).ok())
                .flatten(),
        )
        .bind(&metadata)
        .execute(self.manager.get_pool())
        .await?;

        Ok(world.id.clone())
    }

    async fn get_world(&self, id: &UUID) -> Result<Option<World>> {
        let uuid = uuid::Uuid::parse_str(id.as_str())?;

        let row = sqlx::query(
            "SELECT id, name, agent_id, message_server_id, metadata FROM worlds WHERE id = $1",
        )
        .bind(uuid)
        .fetch_optional(self.manager.get_pool())
        .await?;

        Ok(row.map(|r| {
            WorldRecord {
                id: r.get("id"),
                created_at: chrono::Utc::now(),
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
        Ok(vec![])
    }

    async fn update_world(&self, _world: &World) -> Result<()> {
        Ok(())
    }

    async fn get_rooms_by_ids(&self, _room_ids: &[UUID]) -> Result<Vec<Room>> {
        Ok(vec![])
    }

    async fn create_rooms(&self, _rooms: &[Room]) -> Result<Vec<UUID>> {
        Ok(vec![])
    }

    async fn delete_room(&self, _room_id: &UUID) -> Result<()> {
        Ok(())
    }

    async fn delete_rooms_by_world_id(&self, _world_id: &UUID) -> Result<()> {
        Ok(())
    }

    async fn update_room(&self, _room: &Room) -> Result<()> {
        Ok(())
    }

    async fn get_rooms_by_world(&self, _world_id: &UUID) -> Result<Vec<Room>> {
        Ok(vec![])
    }

    async fn get_rooms_for_participant(&self, _entity_id: &UUID) -> Result<Vec<UUID>> {
        Ok(vec![])
    }

    async fn get_rooms_for_participants(&self, _user_ids: &[UUID]) -> Result<Vec<UUID>> {
        Ok(vec![])
    }

    async fn remove_participant(&self, _entity_id: &UUID, _room_id: &UUID) -> Result<bool> {
        Ok(true)
    }

    async fn get_participants_for_entity(&self, _entity_id: &UUID) -> Result<Vec<Participant>> {
        Ok(vec![])
    }

    async fn get_participants_for_room(&self, _room_id: &UUID) -> Result<Vec<UUID>> {
        Ok(vec![])
    }

    async fn is_room_participant(&self, _room_id: &UUID, _entity_id: &UUID) -> Result<bool> {
        Ok(false)
    }

    async fn add_participants_room(&self, _entity_ids: &[UUID], _room_id: &UUID) -> Result<bool> {
        Ok(true)
    }

    async fn get_participant_user_state(
        &self,
        _room_id: &UUID,
        _entity_id: &UUID,
    ) -> Result<Option<ParticipantUserState>> {
        Ok(None)
    }

    async fn set_participant_user_state(
        &self,
        _room_id: &UUID,
        _entity_id: &UUID,
        _state: Option<ParticipantUserState>,
    ) -> Result<()> {
        Ok(())
    }

    async fn create_relationship(&self, _params: CreateRelationshipParams) -> Result<bool> {
        Ok(true)
    }

    async fn update_relationship(&self, _relationship: &Relationship) -> Result<()> {
        Ok(())
    }

    async fn get_relationship(
        &self,
        _params: GetRelationshipParams,
    ) -> Result<Option<Relationship>> {
        Ok(None)
    }

    async fn get_relationships(
        &self,
        _params: GetRelationshipsParams,
    ) -> Result<Vec<Relationship>> {
        Ok(vec![])
    }

    async fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let row = sqlx::query("SELECT value FROM cache WHERE key = $1")
            .bind(key)
            .fetch_optional(self.manager.get_pool())
            .await?;

        if let Some(r) = row {
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

    async fn create_task(&self, _task: &Task) -> Result<UUID> {
        Ok(UUID::new_v4())
    }

    async fn get_tasks(&self, _params: GetTasksParams) -> Result<Vec<Task>> {
        Ok(vec![])
    }

    async fn get_task(&self, _id: &UUID) -> Result<Option<Task>> {
        Ok(None)
    }

    async fn get_tasks_by_name(&self, _name: &str) -> Result<Vec<Task>> {
        Ok(vec![])
    }

    async fn update_task(&self, _id: &UUID, _task: &Task) -> Result<()> {
        Ok(())
    }

    async fn delete_task(&self, _id: &UUID) -> Result<()> {
        Ok(())
    }
}
