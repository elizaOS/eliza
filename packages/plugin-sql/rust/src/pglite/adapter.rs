//! PGLite adapter implementation for elizaOS WASM environments

#![cfg(feature = "wasm")]

use anyhow::Result;
use async_trait::async_trait;
use js_sys::{Array, Reflect};
use wasm_bindgen::JsValue;

use crate::base::*;
use elizaos_core::{
    Agent, Component, Entity, GetMemoriesParams, Log, Memory, Metadata, Participant, Relationship,
    Room, SearchMemoriesParams, Task, World, UUID,
};

use super::PgLiteManager;

/// PGLite database adapter for WASM environments
pub struct PgLiteAdapter {
    manager: PgLiteManager,
    agent_id: String,
}

impl PgLiteAdapter {
    /// Create a new PGLite adapter
    pub async fn new(data_dir: Option<&str>, agent_id: &UUID) -> Result<Self> {
        let manager = PgLiteManager::new(data_dir).await?;

        Ok(PgLiteAdapter {
            manager,
            agent_id: agent_id.to_string(),
        })
    }

    /// Initialize with a JavaScript PGLite instance
    pub async fn init_with_js(&mut self, pglite_js: JsValue) -> Result<()> {
        self.manager.init(pglite_js).await
    }

    /// Helper to parse query results into a Vec of rows
    fn parse_rows(&self, result: &JsValue) -> Result<Vec<JsValue>> {
        let rows = Reflect::get(result, &JsValue::from_str("rows"))
            .map_err(|e| anyhow::anyhow!("Failed to get rows: {:?}", e))?;

        let rows_array = Array::from(&rows);
        Ok(rows_array.iter().collect())
    }
}

#[async_trait(?Send)]
impl DatabaseAdapter for PgLiteAdapter {
    async fn init(&self) -> Result<()> {
        self.manager.run_migrations().await
    }

    async fn is_ready(&self) -> Result<bool> {
        Ok(self.manager.is_initialized())
    }

    async fn close(&self) -> Result<()> {
        self.manager.close().await
    }

    async fn get_connection(&self) -> Result<Box<dyn std::any::Any + Send>> {
        // Return a placeholder since we can't return the JS object directly
        Ok(Box::new(()))
    }

    // Agent methods - delegated through JS interop
    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>> {
        let sql = r#"
            SELECT id, enabled, server_id, created_at, updated_at, name, username,
                   system, bio, message_examples, post_examples, topics, adjectives,
                   knowledge, plugins, settings, style
            FROM agents WHERE id = $1
        "#;

        let params = vec![JsValue::from_str(agent_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        if rows.is_empty() {
            return Ok(None);
        }

        // Parse the first row into an Agent
        let row = &rows[0];
        let character = elizaos_core::Character {
            id: Some(agent_id.clone()),
            name: Reflect::get(row, &JsValue::from_str("name"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default(),
            ..Default::default()
        };

        Ok(Some(elizaos_core::Agent {
            character,
            enabled: Some(true),
            status: None,
            created_at: 0,
            updated_at: 0,
        }))
    }

    async fn get_agents(&self) -> Result<Vec<Agent>> {
        let sql = "SELECT * FROM agents";
        let result = self.manager.query(sql, &[]).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = Reflect::get(&row, &JsValue::from_str("id"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .and_then(|s| UUID::new(&s).ok())?;

                let name = Reflect::get(&row, &JsValue::from_str("name"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_default();

                let character = elizaos_core::Character {
                    id: Some(id),
                    name,
                    ..Default::default()
                };

                Some(elizaos_core::Agent {
                    character,
                    enabled: Some(true),
                    status: None,
                    created_at: 0,
                    updated_at: 0,
                })
            })
            .collect())
    }

    async fn create_agent(&self, agent: &Agent) -> Result<bool> {
        let id = agent
            .character
            .id
            .as_ref()
            .map(|u| u.to_string())
            .unwrap_or_else(|| UUID::new_v4().to_string());

        let bio = serde_json::to_string(&agent.character.bio)?;
        let settings = serde_json::to_string(&agent.character.settings)?;

        let sql = r#"
            INSERT INTO agents (id, enabled, name, username, system, bio, settings)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO NOTHING
        "#;

        let params = vec![
            JsValue::from_str(&id),
            JsValue::from_bool(agent.enabled.unwrap_or(true)),
            JsValue::from_str(&agent.character.name),
            agent
                .character
                .username
                .as_ref()
                .map(|u| JsValue::from_str(u))
                .unwrap_or(JsValue::NULL),
            agent
                .character
                .system
                .as_ref()
                .map(|s| JsValue::from_str(s))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(&bio),
            JsValue::from_str(&settings),
        ];

        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool> {
        let bio = serde_json::to_string(&agent.character.bio)?;
        let settings = serde_json::to_string(&agent.character.settings)?;

        let sql = r#"
            UPDATE agents SET
                name = $2,
                username = $3,
                system = $4,
                bio = $5,
                settings = $6,
                updated_at = now()
            WHERE id = $1
        "#;

        let params = vec![
            JsValue::from_str(agent_id.as_str()),
            JsValue::from_str(&agent.character.name),
            agent
                .character
                .username
                .as_ref()
                .map(|u| JsValue::from_str(u))
                .unwrap_or(JsValue::NULL),
            agent
                .character
                .system
                .as_ref()
                .map(|s| JsValue::from_str(s))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(&bio),
            JsValue::from_str(&settings),
        ];

        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool> {
        let sql = "DELETE FROM agents WHERE id = $1";
        let params = vec![JsValue::from_str(agent_id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    // Memory methods
    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let mut sql = String::from(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE type = $1
            "#,
        );

        let mut js_params = vec![JsValue::from_str(&params.table_name)];

        if params.room_id.is_some() {
            sql.push_str(" AND room_id = $2");
            js_params.push(JsValue::from_str(params.room_id.as_ref().unwrap().as_str()));
        }

        sql.push_str(" ORDER BY created_at DESC");

        if let Some(count) = params.count {
            sql.push_str(&format!(" LIMIT {}", count));
        }

        let result = self.manager.query(&sql, &js_params).await?;
        let rows = self.parse_rows(&result)?;

        // Convert rows to Memory objects
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = Reflect::get(&row, &JsValue::from_str("id"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .and_then(|s| UUID::new(&s).ok())?;

                let entity_id = Reflect::get(&row, &JsValue::from_str("entity_id"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .and_then(|s| UUID::new(&s).ok())
                    .unwrap_or_else(UUID::new_v4);

                let room_id = Reflect::get(&row, &JsValue::from_str("room_id"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .and_then(|s| UUID::new(&s).ok())
                    .unwrap_or_else(UUID::new_v4);

                let content_str = Reflect::get(&row, &JsValue::from_str("content"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_default();

                let content: elizaos_core::Content =
                    serde_json::from_str(&content_str).unwrap_or_default();

                Some(Memory {
                    id: Some(id),
                    entity_id,
                    agent_id: None,
                    created_at: None,
                    content,
                    embedding: None,
                    room_id,
                    world_id: None,
                    unique: Some(true),
                    similarity: None,
                    metadata: None,
                })
            })
            .collect())
    }

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>> {
        let sql = r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE id = $1
        "#;

        let params = vec![JsValue::from_str(id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        if rows.is_empty() {
            return Ok(None);
        }

        // Parse first row
        let row = &rows[0];
        let entity_id = Reflect::get(row, &JsValue::from_str("entity_id"))
            .ok()
            .and_then(|v| v.as_string())
            .and_then(|s| UUID::new(&s).ok())
            .unwrap_or_else(UUID::new_v4);

        let room_id = Reflect::get(row, &JsValue::from_str("room_id"))
            .ok()
            .and_then(|v| v.as_string())
            .and_then(|s| UUID::new(&s).ok())
            .unwrap_or_else(UUID::new_v4);

        Ok(Some(Memory {
            id: Some(id.clone()),
            entity_id,
            agent_id: None,
            created_at: None,
            content: elizaos_core::Content::default(),
            embedding: None,
            room_id,
            world_id: None,
            unique: Some(true),
            similarity: None,
            metadata: None,
        }))
    }

    async fn get_memories_by_ids(
        &self,
        ids: &[UUID],
        _table_name: Option<&str>,
    ) -> Result<Vec<Memory>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let id_list = ids
            .iter()
            .map(|id| format!("'{}'", id.as_str()))
            .collect::<Vec<_>>()
            .join(",");

        let sql = format!(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE id IN ({})
            "#,
            id_list
        );

        let result = self.manager.query(&sql, &[]).await?;
        let _rows = self.parse_rows(&result)?;

        Ok(vec![])
    }

    async fn get_memories_by_room_ids(
        &self,
        table_name: &str,
        room_ids: &[UUID],
        limit: Option<i32>,
    ) -> Result<Vec<Memory>> {
        if room_ids.is_empty() {
            return Ok(vec![]);
        }

        let room_list = room_ids
            .iter()
            .map(|id| format!("'{}'", id.as_str()))
            .collect::<Vec<_>>()
            .join(",");

        let limit_str = limit.map(|l| format!(" LIMIT {}", l)).unwrap_or_default();

        let sql = format!(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE type = $1 AND room_id IN ({})
            ORDER BY created_at DESC
            {}
            "#,
            room_list, limit_str
        );

        let params = vec![JsValue::from_str(table_name)];
        let result = self.manager.query(&sql, &params).await?;
        let _rows = self.parse_rows(&result)?;

        Ok(vec![])
    }

    async fn get_cached_embeddings(
        &self,
        _params: GetCachedEmbeddingsParams,
    ) -> Result<Vec<EmbeddingSearchResult>> {
        Ok(vec![])
    }

    async fn search_memories(&self, _params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        // Vector search would need PGVector extension in PGLite
        Ok(vec![])
    }

    async fn create_memory(
        &self,
        memory: &Memory,
        table_name: &str,
        _unique: bool,
    ) -> Result<UUID> {
        let id = memory.id.clone().unwrap_or_else(UUID::new_v4);
        let content = serde_json::to_string(&memory.content)?;
        let metadata = serde_json::to_string(&memory.metadata)?;

        let sql = r#"
            INSERT INTO memories (id, type, content, entity_id, agent_id, room_id, world_id, "unique", metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#;

        let params = vec![
            JsValue::from_str(id.as_str()),
            JsValue::from_str(table_name),
            JsValue::from_str(&content),
            JsValue::from_str(memory.entity_id.as_str()),
            memory
                .agent_id
                .as_ref()
                .map(|a| JsValue::from_str(a.as_str()))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(memory.room_id.as_str()),
            memory
                .world_id
                .as_ref()
                .map(|w| JsValue::from_str(w.as_str()))
                .unwrap_or(JsValue::NULL),
            JsValue::from_bool(memory.unique.unwrap_or(true)),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(id)
    }

    async fn update_memory(&self, memory: &Memory) -> Result<bool> {
        let id = memory
            .id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Memory ID is required"))?;
        let content = serde_json::to_string(&memory.content)?;
        let metadata = serde_json::to_string(&memory.metadata)?;

        let sql = r#"
            UPDATE memories SET content = $2, metadata = $3 WHERE id = $1
        "#;

        let params = vec![
            JsValue::from_str(id.as_str()),
            JsValue::from_str(&content),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn delete_memory(&self, memory_id: &UUID) -> Result<()> {
        let sql = "DELETE FROM memories WHERE id = $1";
        let params = vec![JsValue::from_str(memory_id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn delete_many_memories(&self, memory_ids: &[UUID]) -> Result<()> {
        if memory_ids.is_empty() {
            return Ok(());
        }

        let id_list = memory_ids
            .iter()
            .map(|id| format!("'{}'", id.as_str()))
            .collect::<Vec<_>>()
            .join(",");

        let sql = format!("DELETE FROM memories WHERE id IN ({})", id_list);
        self.manager.exec(&sql).await?;
        Ok(())
    }

    async fn delete_all_memories(&self, room_id: &UUID, table_name: &str) -> Result<()> {
        let sql = "DELETE FROM memories WHERE room_id = $1 AND type = $2";
        let params = vec![
            JsValue::from_str(room_id.as_str()),
            JsValue::from_str(table_name),
        ];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn count_memories(
        &self,
        room_id: &UUID,
        _unique: bool,
        table_name: Option<&str>,
    ) -> Result<i64> {
        let sql = if let Some(table) = table_name {
            format!(
                "SELECT COUNT(*) as count FROM memories WHERE room_id = $1 AND type = '{}'",
                table
            )
        } else {
            "SELECT COUNT(*) as count FROM memories WHERE room_id = $1".to_string()
        };

        let params = vec![JsValue::from_str(room_id.as_str())];
        let result = self.manager.query(&sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        if let Some(row) = rows.first() {
            let count = Reflect::get(row, &JsValue::from_str("count"))
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            Ok(count as i64)
        } else {
            Ok(0)
        }
    }

    async fn ensure_embedding_dimension(&self, _dimension: i32) -> Result<()> {
        Ok(())
    }

    async fn get_memories_by_world_id(
        &self,
        _world_id: &UUID,
        _count: Option<i32>,
        _table_name: Option<&str>,
    ) -> Result<Vec<Memory>> {
        Ok(vec![])
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
    async fn create_world(&self, _world: &World) -> Result<UUID> {
        Ok(UUID::new_v4())
    }
    async fn get_world(&self, _id: &UUID) -> Result<Option<World>> {
        Ok(None)
    }
    async fn remove_world(&self, _id: &UUID) -> Result<()> {
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
    async fn get_cache<T: serde::de::DeserializeOwned>(&self, _key: &str) -> Result<Option<T>> {
        Ok(None)
    }
    async fn set_cache<T: serde::Serialize + Send + Sync>(
        &self,
        _key: &str,
        _value: &T,
    ) -> Result<bool> {
        Ok(true)
    }
    async fn delete_cache(&self, _key: &str) -> Result<bool> {
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
