#![allow(missing_docs)]

#![cfg(feature = "wasm")]

use anyhow::Result;
use async_trait::async_trait;
use js_sys::{Array, Reflect};
use wasm_bindgen::JsValue;

use crate::base::*;
use elizaos::{
    Agent, Component, Entity, GetMemoriesParams, Log, Memory, Metadata, Relationship, Room,
    SearchMemoriesParams, Task, TaskStatus, World, UUID,
};

use super::PgLiteManager;

pub struct PgLiteAdapter {
    manager: PgLiteManager,
    agent_id: String,
}

impl PgLiteAdapter {
    pub async fn new(data_dir: Option<&str>, agent_id: &UUID) -> Result<Self> {
        let manager = PgLiteManager::new(data_dir).await?;

        Ok(PgLiteAdapter {
            manager,
            agent_id: agent_id.to_string(),
        })
    }

    pub async fn init_with_js(&mut self, pglite_js: JsValue) -> Result<()> {
        self.manager.init(pglite_js).await
    }

    fn parse_rows(&self, result: &JsValue) -> Result<Vec<JsValue>> {
        let rows = Reflect::get(result, &JsValue::from_str("rows"))
            .map_err(|e| anyhow::anyhow!("Failed to get rows: {:?}", e))?;

        let rows_array = Array::from(&rows);
        Ok(rows_array.iter().collect())
    }

    fn get_string(&self, row: &JsValue, field: &str) -> Option<String> {
        Reflect::get(row, &JsValue::from_str(field))
            .ok()
            .and_then(|v| v.as_string())
    }

    fn get_uuid(&self, row: &JsValue, field: &str) -> Option<UUID> {
        self.get_string(row, field).and_then(|s| UUID::new(&s).ok())
    }

    fn get_bool(&self, row: &JsValue, field: &str) -> Option<bool> {
        Reflect::get(row, &JsValue::from_str(field))
            .ok()
            .and_then(|v| v.as_bool())
    }

    fn get_f64(&self, row: &JsValue, field: &str) -> Option<f64> {
        Reflect::get(row, &JsValue::from_str(field))
            .ok()
            .and_then(|v| v.as_f64())
    }

    fn get_json<T: serde::de::DeserializeOwned>(&self, row: &JsValue, field: &str) -> Option<T> {
        self.get_string(row, field)
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    /// Parse an Entity from a JS row
    fn parse_entity(&self, row: &JsValue) -> Option<Entity> {
        let id = self.get_uuid(row, "id");
        let agent_id = self.get_uuid(row, "agent_id")?;
        let names: Vec<String> = self.get_json(row, "names").unwrap_or_default();
        let metadata: Metadata = self.get_json(row, "metadata").unwrap_or_default();

        Some(Entity {
            id,
            names,
            metadata,
            agent_id,
            components: None,
        })
    }

    fn parse_room(&self, row: &JsValue) -> Option<Room> {
        let id = self.get_uuid(row, "id")?;

        Some(Room {
            id,
            name: self.get_string(row, "name"),
            agent_id: self.get_uuid(row, "agent_id"),
            source: self.get_string(row, "source").unwrap_or_default(),
            room_type: self.get_string(row, "type").unwrap_or_default(),
            channel_id: self.get_string(row, "channel_id"),
            message_server_id: self.get_uuid(row, "message_server_id"),
            world_id: self.get_uuid(row, "world_id"),
            metadata: self.get_json(row, "metadata"),
        })
    }

    /// Parse a World from a JS row
    fn parse_world(&self, row: &JsValue) -> Option<World> {
        let id = self.get_uuid(row, "id")?;
        let agent_id = self.get_uuid(row, "agent_id")?;

        Some(World {
            id,
            name: self.get_string(row, "name"),
            agent_id,
            message_server_id: self.get_uuid(row, "message_server_id"),
            metadata: self.get_json(row, "metadata").unwrap_or_default(),
        })
    }

    fn parse_component(&self, row: &JsValue) -> Option<Component> {
        let id = self.get_uuid(row, "id");
        let entity_id = self.get_uuid(row, "entity_id")?;
        let agent_id = self.get_uuid(row, "agent_id")?;
        let room_id = self.get_uuid(row, "room_id")?;
        let world_id = self.get_uuid(row, "world_id")?;
        let source_entity_id = self.get_uuid(row, "source_entity_id")?;

        Some(Component {
            id,
            entity_id,
            agent_id,
            room_id,
            world_id,
            source_entity_id,
            component_type: self.get_string(row, "type").unwrap_or_default(),
            data: self.get_json(row, "data").unwrap_or_default(),
            created_at: None,
        })
    }

    /// Parse a Log from a JS row
    fn parse_log(&self, row: &JsValue) -> Option<Log> {
        let id = self.get_uuid(row, "id");
        let entity_id = self.get_uuid(row, "entity_id")?;

        Some(Log {
            id,
            entity_id,
            room_id: self.get_uuid(row, "room_id"),
            body: elizaos::LogBody::Base(self.get_json(row, "body").unwrap_or_default()),
            log_type: self.get_string(row, "type").unwrap_or_default(),
            created_at: self.get_string(row, "created_at").unwrap_or_default(),
        })
    }

    fn parse_relationship(&self, row: &JsValue) -> Option<Relationship> {
        let id = self.get_uuid(row, "id")?;
        let source_entity_id = self.get_uuid(row, "source_entity_id")?;
        let target_entity_id = self.get_uuid(row, "target_entity_id")?;
        let agent_id = self.get_uuid(row, "agent_id")?;

        Some(Relationship {
            id,
            source_entity_id,
            target_entity_id,
            agent_id,
            tags: self.get_json(row, "tags").unwrap_or_default(),
            metadata: self.get_json(row, "metadata").unwrap_or_default(),
            created_at: self.get_string(row, "created_at"),
        })
    }

    /// Parse a Task from a JS row
    fn parse_task(&self, row: &JsValue) -> Option<Task> {
        let id = self.get_uuid(row, "id");
        let status_str = self.get_string(row, "status").unwrap_or_default();
        let status = match status_str.as_str() {
            "pending" => TaskStatus::Pending,
            "in_progress" | "running" => TaskStatus::InProgress,
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => TaskStatus::Pending,
        };

        Some(Task {
            id,
            name: self.get_string(row, "name").unwrap_or_default(),
            description: self.get_string(row, "description"),
            status: Some(status),
            room_id: self.get_uuid(row, "room_id"),
            world_id: self.get_uuid(row, "world_id"),
            entity_id: self.get_uuid(row, "entity_id"),
            tags: self.get_json(row, "tags"),
            metadata: self.get_json(row, "metadata"),
            created_at: self.get_f64(row, "created_at").map(|f| f as i64),
            updated_at: self.get_f64(row, "updated_at").map(|f| f as i64),
            scheduled_at: None,
            repeat_interval: None,
            data: None,
        })
    }

    fn parse_participant_info(&self, row: &JsValue) -> Option<ParticipantInfo> {
        let id = self.get_uuid(row, "id")?;
        let entity_id = self.get_uuid(row, "entity_id")?;
        let room_id = self.get_uuid(row, "room_id")?;

        Some(ParticipantInfo {
            id,
            entity_id,
            room_id,
            user_state: self.get_string(row, "user_state"),
            created_at: self.get_f64(row, "created_at").map(|f| f as i64),
        })
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

    async fn get_connection(&self) -> Result<DatabaseConnection> {
        Ok(DatabaseConnection::None)
    }

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

        let row = &rows[0];
        let character = elizaos::Character {
            id: Some(agent_id.clone()),
            name: self.get_string(row, "name").unwrap_or_default(),
            username: self.get_string(row, "username"),
            system: self.get_string(row, "system"),
            bio: self.get_json(row, "bio").unwrap_or_default(),
            ..Default::default()
        };

        Ok(Some(elizaos::Agent {
            character,
            enabled: self.get_bool(row, "enabled"),
            status: None,
            created_at: self.get_f64(row, "created_at").unwrap_or(0.0) as i64,
            updated_at: self.get_f64(row, "updated_at").unwrap_or(0.0) as i64,
        }))
    }

    async fn get_agents(&self) -> Result<Vec<Agent>> {
        let sql = "SELECT * FROM agents";
        let result = self.manager.query(sql, &[]).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = self.get_uuid(&row, "id")?;
                let character = elizaos::Character {
                    id: Some(id),
                    name: self.get_string(&row, "name").unwrap_or_default(),
                    username: self.get_string(&row, "username"),
                    system: self.get_string(&row, "system"),
                    bio: self.get_json(&row, "bio").unwrap_or_default(),
                    ..Default::default()
                };

                Some(elizaos::Agent {
                    character,
                    enabled: self.get_bool(&row, "enabled"),
                    status: None,
                    created_at: self.get_f64(&row, "created_at").unwrap_or(0.0) as i64,
                    updated_at: self.get_f64(&row, "updated_at").unwrap_or(0.0) as i64,
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

    async fn get_entities_by_ids(&self, entity_ids: &[UUID]) -> Result<Vec<Entity>> {
        if entity_ids.is_empty() {
            return Ok(vec![]);
        }

        let id_list = entity_ids
            .iter()
            .map(|id| format!("'{}'", id.as_str()))
            .collect::<Vec<_>>()
            .join(",");

        let sql = format!(
            "SELECT id, created_at, updated_at, names, metadata, agent_id FROM entities WHERE id IN ({})",
            id_list
        );

        let result = self.manager.query(&sql, &[]).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_entity(&row)).collect())
    }

    async fn get_entities_for_room(
        &self,
        room_id: &UUID,
        _include_components: bool,
    ) -> Result<Vec<Entity>> {
        let sql = r#"
            SELECT e.id, e.created_at, e.updated_at, e.names, e.metadata, e.agent_id
            FROM entities e
            JOIN participants p ON e.id = p.entity_id
            WHERE p.room_id = $1
        "#;

        let params = vec![JsValue::from_str(room_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_entity(&row)).collect())
    }

    async fn create_entities(&self, entities: &[Entity]) -> Result<bool> {
        for entity in entities {
            let id = entity
                .id
                .as_ref()
                .map(|u| u.to_string())
                .unwrap_or_else(|| UUID::new_v4().to_string());
            let names = serde_json::to_string(&entity.names)?;
            let metadata = serde_json::to_string(&entity.metadata)?;

            let sql = r#"
                INSERT INTO entities (id, agent_id, names, metadata)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (id) DO NOTHING
            "#;

            let params = vec![
                JsValue::from_str(&id),
                JsValue::from_str(entity.agent_id.as_str()),
                JsValue::from_str(&names),
                JsValue::from_str(&metadata),
            ];

            self.manager.query(sql, &params).await?;
        }
        Ok(true)
    }

    async fn update_entity(&self, entity: &Entity) -> Result<()> {
        let id = entity
            .id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Entity ID is required"))?;
        let names = serde_json::to_string(&entity.names)?;
        let metadata = serde_json::to_string(&entity.metadata)?;

        let sql = r#"
            UPDATE entities SET names = $2, metadata = $3, updated_at = now() WHERE id = $1
        "#;

        let params = vec![
            JsValue::from_str(id.as_str()),
            JsValue::from_str(&names),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(())
    }

    // =========================================================================
    // Component Methods
    // =========================================================================

    async fn get_component(
        &self,
        entity_id: &UUID,
        component_type: &str,
        _world_id: Option<&UUID>,
        _source_entity_id: Option<&UUID>,
    ) -> Result<Option<Component>> {
        let sql = r#"
            SELECT id, entity_id, agent_id, room_id, world_id, source_entity_id, type, data, created_at
            FROM components WHERE entity_id = $1 AND type = $2 LIMIT 1
        "#;

        let params = vec![
            JsValue::from_str(entity_id.as_str()),
            JsValue::from_str(component_type),
        ];

        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.first().and_then(|row| self.parse_component(row)))
    }

    async fn get_components(
        &self,
        entity_id: &UUID,
        _world_id: Option<&UUID>,
        _source_entity_id: Option<&UUID>,
    ) -> Result<Vec<Component>> {
        let sql = r#"
            SELECT id, entity_id, agent_id, room_id, world_id, source_entity_id, type, data, created_at
            FROM components WHERE entity_id = $1
        "#;

        let params = vec![JsValue::from_str(entity_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_component(&row)).collect())
    }

    async fn create_component(&self, component: &Component) -> Result<bool> {
        let id = component
            .id
            .as_ref()
            .map(|u| u.to_string())
            .unwrap_or_else(|| UUID::new_v4().to_string());
        let data = serde_json::to_string(&component.data)?;

        let sql = r#"
            INSERT INTO components (id, entity_id, agent_id, room_id, world_id, source_entity_id, type, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
        "#;

        let params = vec![
            JsValue::from_str(&id),
            JsValue::from_str(component.entity_id.as_str()),
            JsValue::from_str(component.agent_id.as_str()),
            JsValue::from_str(component.room_id.as_str()),
            JsValue::from_str(component.world_id.as_str()),
            JsValue::from_str(component.source_entity_id.as_str()),
            JsValue::from_str(&component.component_type),
            JsValue::from_str(&data),
        ];

        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn update_component(&self, component: &Component) -> Result<()> {
        let id = component
            .id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Component ID is required"))?;
        let data = serde_json::to_string(&component.data)?;

        let sql = "UPDATE components SET data = $2 WHERE id = $1";
        let params = vec![JsValue::from_str(id.as_str()), JsValue::from_str(&data)];

        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn delete_component(&self, component_id: &UUID) -> Result<()> {
        let sql = "DELETE FROM components WHERE id = $1";
        let params = vec![JsValue::from_str(component_id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let mut sql = String::from(
            r#"
            SELECT id, type, created_at, content, entity_id, agent_id,
                   room_id, world_id, "unique", metadata
            FROM memories WHERE type = $1
            "#,
        );

        let mut js_params = vec![JsValue::from_str(&params.table_name)];

        let mut idx: i32 = 2;

        if let Some(entity_id) = params.entity_id.as_ref() {
            sql.push_str(&format!(" AND entity_id = ${}", idx));
            js_params.push(JsValue::from_str(entity_id.as_str()));
            idx += 1;
        }

        if let Some(room_id) = params.room_id.as_ref() {
            sql.push_str(&format!(" AND room_id = ${}", idx));
            js_params.push(JsValue::from_str(room_id.as_str()));
            idx += 1;
        }

        if let Some(agent_id) = params.agent_id.as_ref() {
            sql.push_str(&format!(" AND agent_id = ${}", idx));
            js_params.push(JsValue::from_str(agent_id.as_str()));
            idx += 1;
        }

        if let Some(world_id) = params.world_id.as_ref() {
            sql.push_str(&format!(" AND world_id = ${}", idx));
            js_params.push(JsValue::from_str(world_id.as_str()));
            idx += 1;
        }

        if params.unique.unwrap_or(false) {
            sql.push_str(r#" AND "unique" = true"#);
        }

        if let Some(start) = params.start {
            sql.push_str(&format!(" AND created_at >= ${}", idx));
            js_params.push(JsValue::from_f64(start as f64));
            idx += 1;
        }

        if let Some(end) = params.end {
            sql.push_str(&format!(" AND created_at <= ${}", idx));
            js_params.push(JsValue::from_f64(end as f64));
            idx += 1;
        }

        sql.push_str(" ORDER BY created_at DESC");

        if let Some(count) = params.count {
            sql.push_str(&format!(" LIMIT {}", count));
        }

        if let Some(offset) = params.offset {
            sql.push_str(&format!(" OFFSET {}", offset));
        }

        let result = self.manager.query(&sql, &js_params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = self.get_uuid(&row, "id")?;
                let entity_id = self.get_uuid(&row, "entity_id").unwrap_or_else(UUID::new_v4);
                let room_id = self.get_uuid(&row, "room_id").unwrap_or_else(UUID::new_v4);
                let content: elizaos::Content = self.get_json(&row, "content").unwrap_or_default();

                Some(Memory {
                    id: Some(id),
                    entity_id,
                    agent_id: self.get_uuid(&row, "agent_id"),
                    created_at: self.get_f64(&row, "created_at").map(|f| f as i64),
                    content,
                    embedding: None,
                    room_id,
                    world_id: self.get_uuid(&row, "world_id"),
                    unique: self.get_bool(&row, "unique"),
                    similarity: None,
                    metadata: self.get_json(&row, "metadata"),
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

        let row = &rows[0];
        let entity_id = self.get_uuid(row, "entity_id").unwrap_or_else(UUID::new_v4);
        let room_id = self.get_uuid(row, "room_id").unwrap_or_else(UUID::new_v4);
        let content: elizaos::Content = self.get_json(row, "content").unwrap_or_default();

        Ok(Some(Memory {
            id: Some(id.clone()),
            entity_id,
            agent_id: self.get_uuid(row, "agent_id"),
            created_at: self.get_f64(row, "created_at").map(|f| f as i64),
            content,
            embedding: None,
            room_id,
            world_id: self.get_uuid(row, "world_id"),
            unique: self.get_bool(row, "unique"),
            similarity: None,
            metadata: self.get_json(row, "metadata"),
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
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = self.get_uuid(&row, "id")?;
                let entity_id = self.get_uuid(&row, "entity_id").unwrap_or_else(UUID::new_v4);
                let room_id = self.get_uuid(&row, "room_id").unwrap_or_else(UUID::new_v4);
                let content: elizaos::Content = self.get_json(&row, "content").unwrap_or_default();

                Some(Memory {
                    id: Some(id),
                    entity_id,
                    agent_id: self.get_uuid(&row, "agent_id"),
                    created_at: self.get_f64(&row, "created_at").map(|f| f as i64),
                    content,
                    embedding: None,
                    room_id,
                    world_id: self.get_uuid(&row, "world_id"),
                    unique: self.get_bool(&row, "unique"),
                    similarity: None,
                    metadata: self.get_json(&row, "metadata"),
                })
            })
            .collect())
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
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = self.get_uuid(&row, "id")?;
                let entity_id = self.get_uuid(&row, "entity_id").unwrap_or_else(UUID::new_v4);
                let room_id = self.get_uuid(&row, "room_id").unwrap_or_else(UUID::new_v4);
                let content: elizaos::Content = self.get_json(&row, "content").unwrap_or_default();

                Some(Memory {
                    id: Some(id),
                    entity_id,
                    agent_id: self.get_uuid(&row, "agent_id"),
                    created_at: self.get_f64(&row, "created_at").map(|f| f as i64),
                    content,
                    embedding: None,
                    room_id,
                    world_id: self.get_uuid(&row, "world_id"),
                    unique: self.get_bool(&row, "unique"),
                    similarity: None,
                    metadata: self.get_json(&row, "metadata"),
                })
            })
            .collect())
    }

    async fn get_cached_embeddings(
        &self,
        _params: GetCachedEmbeddingsParams,
    ) -> Result<Vec<EmbeddingSearchResult>> {
        // Vector search requires pgvector which may not be available in PGLite
        Ok(vec![])
    }

    async fn search_memories(&self, _params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        // Vector search requires pgvector which may not be available in PGLite
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

        let sql = "UPDATE memories SET content = $2, metadata = $3 WHERE id = $1";

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
            let count = self.get_f64(row, "count").unwrap_or(0.0);
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
        world_id: &UUID,
        count: Option<i32>,
        table_name: Option<&str>,
    ) -> Result<Vec<Memory>> {
        let limit = count.map(|c| format!(" LIMIT {}", c)).unwrap_or_default();

        let sql = if let Some(table) = table_name {
            format!(
                r#"
                SELECT id, type, created_at, content, entity_id, agent_id,
                       room_id, world_id, "unique", metadata
                FROM memories WHERE world_id = $1 AND type = '{}'
                ORDER BY created_at DESC
                {}
                "#,
                table, limit
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

        let params = vec![JsValue::from_str(world_id.as_str())];
        let result = self.manager.query(&sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let id = self.get_uuid(&row, "id")?;
                let entity_id = self.get_uuid(&row, "entity_id").unwrap_or_else(UUID::new_v4);
                let room_id = self.get_uuid(&row, "room_id").unwrap_or_else(UUID::new_v4);
                let content: elizaos::Content = self.get_json(&row, "content").unwrap_or_default();

                Some(Memory {
                    id: Some(id),
                    entity_id,
                    agent_id: self.get_uuid(&row, "agent_id"),
                    created_at: self.get_f64(&row, "created_at").map(|f| f as i64),
                    content,
                    embedding: None,
                    room_id,
                    world_id: self.get_uuid(&row, "world_id"),
                    unique: self.get_bool(&row, "unique"),
                    similarity: None,
                    metadata: self.get_json(&row, "metadata"),
                })
            })
            .collect())
    }

    // =========================================================================
    // Log Methods
    // =========================================================================

    async fn log(&self, params: LogParams) -> Result<()> {
        let body = serde_json::to_string(&params.body)?;

        let sql = r#"
            INSERT INTO logs (id, entity_id, room_id, type, body)
            VALUES ($1, $2, $3, $4, $5)
        "#;

        let js_params = vec![
            JsValue::from_str(&UUID::new_v4().to_string()),
            JsValue::from_str(params.entity_id.as_str()),
            params
                .room_id
                .as_ref()
                .map(|r| JsValue::from_str(r.as_str()))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(&params.log_type),
            JsValue::from_str(&body),
        ];

        self.manager.query(sql, &js_params).await?;
        Ok(())
    }

    async fn get_logs(&self, params: GetLogsParams) -> Result<Vec<Log>> {
        let mut sql = String::from(
            "SELECT id, entity_id, room_id, type, body, created_at FROM logs WHERE 1=1",
        );
        let mut js_params = vec![];
        let mut param_idx = 1;

        if let Some(entity_id) = &params.entity_id {
            sql.push_str(&format!(" AND entity_id = ${}", param_idx));
            js_params.push(JsValue::from_str(entity_id.as_str()));
            param_idx += 1;
        }
        if let Some(room_id) = &params.room_id {
            sql.push_str(&format!(" AND room_id = ${}", param_idx));
            js_params.push(JsValue::from_str(room_id.as_str()));
            param_idx += 1;
        }
        if let Some(log_type) = &params.log_type {
            sql.push_str(&format!(" AND type = ${}", param_idx));
            js_params.push(JsValue::from_str(log_type));
        }

        sql.push_str(" ORDER BY created_at DESC");

        if let Some(count) = params.count {
            sql.push_str(&format!(" LIMIT {}", count));
        }

        let result = self.manager.query(&sql, &js_params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_log(&row)).collect())
    }

    async fn delete_log(&self, log_id: &UUID) -> Result<()> {
        let sql = "DELETE FROM logs WHERE id = $1";
        let params = vec![JsValue::from_str(log_id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn create_world(&self, world: &World) -> Result<UUID> {
        let metadata = serde_json::to_string(&world.metadata)?;

        let sql = r#"
            INSERT INTO worlds (id, name, agent_id, message_server_id, metadata)
            VALUES ($1, $2, $3, $4, $5)
        "#;

        let params = vec![
            JsValue::from_str(world.id.as_str()),
            world
                .name
                .as_ref()
                .map(|n| JsValue::from_str(n))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(world.agent_id.as_str()),
            world
                .message_server_id
                .as_ref()
                .map(|m| JsValue::from_str(m.as_str()))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(world.id.clone())
    }

    async fn get_world(&self, id: &UUID) -> Result<Option<World>> {
        let sql = "SELECT id, created_at, name, agent_id, message_server_id, metadata FROM worlds WHERE id = $1";
        let params = vec![JsValue::from_str(id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.first().and_then(|row| self.parse_world(row)))
    }

    async fn remove_world(&self, id: &UUID) -> Result<()> {
        let sql = "DELETE FROM worlds WHERE id = $1";
        let params = vec![JsValue::from_str(id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn get_all_worlds(&self) -> Result<Vec<World>> {
        let sql = "SELECT id, created_at, name, agent_id, message_server_id, metadata FROM worlds";
        let result = self.manager.query(sql, &[]).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_world(&row)).collect())
    }

    async fn update_world(&self, world: &World) -> Result<()> {
        let metadata = serde_json::to_string(&world.metadata)?;

        let sql = "UPDATE worlds SET name = $2, metadata = $3 WHERE id = $1";
        let params = vec![
            JsValue::from_str(world.id.as_str()),
            world
                .name
                .as_ref()
                .map(|n| JsValue::from_str(n))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn get_rooms_by_ids(&self, room_ids: &[UUID]) -> Result<Vec<Room>> {
        if room_ids.is_empty() {
            return Ok(vec![]);
        }

        let id_list = room_ids
            .iter()
            .map(|id| format!("'{}'", id.as_str()))
            .collect::<Vec<_>>()
            .join(",");

        let sql = format!(
            "SELECT id, created_at, name, agent_id, source, type, channel_id, message_server_id, world_id, metadata FROM rooms WHERE id IN ({})",
            id_list
        );

        let result = self.manager.query(&sql, &[]).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_room(&row)).collect())
    }

    async fn create_rooms(&self, rooms: &[Room]) -> Result<Vec<UUID>> {
        let mut created_ids = Vec::new();

        for room in rooms {
            let metadata = serde_json::to_string(&room.metadata)?;

            let sql = r#"
                INSERT INTO rooms (id, name, agent_id, source, type, channel_id, message_server_id, world_id, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING
            "#;

            let params = vec![
                JsValue::from_str(room.id.as_str()),
                room.name
                    .as_ref()
                    .map(|n| JsValue::from_str(n))
                    .unwrap_or(JsValue::NULL),
                room.agent_id
                    .as_ref()
                    .map(|a| JsValue::from_str(a.as_str()))
                    .unwrap_or(JsValue::NULL),
                JsValue::from_str(&room.source),
                JsValue::from_str(&room.room_type),
                room.channel_id
                    .as_ref()
                    .map(|c| JsValue::from_str(c))
                    .unwrap_or(JsValue::NULL),
                room.message_server_id
                    .as_ref()
                    .map(|m| JsValue::from_str(m.as_str()))
                    .unwrap_or(JsValue::NULL),
                room.world_id
                    .as_ref()
                    .map(|w| JsValue::from_str(w.as_str()))
                    .unwrap_or(JsValue::NULL),
                JsValue::from_str(&metadata),
            ];

            self.manager.query(sql, &params).await?;
            created_ids.push(room.id.clone());
        }

        Ok(created_ids)
    }

    async fn delete_room(&self, room_id: &UUID) -> Result<()> {
        let sql = "DELETE FROM rooms WHERE id = $1";
        let params = vec![JsValue::from_str(room_id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn delete_rooms_by_world_id(&self, world_id: &UUID) -> Result<()> {
        let sql = "DELETE FROM rooms WHERE world_id = $1";
        let params = vec![JsValue::from_str(world_id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn update_room(&self, room: &Room) -> Result<()> {
        let metadata = serde_json::to_string(&room.metadata)?;

        let sql = "UPDATE rooms SET name = $2, metadata = $3 WHERE id = $1";
        let params = vec![
            JsValue::from_str(room.id.as_str()),
            room.name
                .as_ref()
                .map(|n| JsValue::from_str(n))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn get_rooms_by_world(&self, world_id: &UUID) -> Result<Vec<Room>> {
        let sql = "SELECT id, created_at, name, agent_id, source, type, channel_id, message_server_id, world_id, metadata FROM rooms WHERE world_id = $1";
        let params = vec![JsValue::from_str(world_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_room(&row)).collect())
    }

    // =========================================================================
    // Participant Methods
    // =========================================================================

    async fn get_rooms_for_participant(&self, entity_id: &UUID) -> Result<Vec<UUID>> {
        let sql = "SELECT room_id FROM participants WHERE entity_id = $1";
        let params = vec![JsValue::from_str(entity_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| self.get_uuid(&row, "room_id"))
            .collect())
    }

    async fn get_rooms_for_participants(&self, user_ids: &[UUID]) -> Result<Vec<UUID>> {
        if user_ids.is_empty() {
            return Ok(vec![]);
        }

        let id_list = user_ids
            .iter()
            .map(|id| format!("'{}'", id.as_str()))
            .collect::<Vec<_>>()
            .join(",");

        let sql = format!(
            "SELECT DISTINCT room_id FROM participants WHERE entity_id IN ({})",
            id_list
        );

        let result = self.manager.query(&sql, &[]).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| self.get_uuid(&row, "room_id"))
            .collect())
    }

    async fn remove_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool> {
        let sql = "DELETE FROM participants WHERE entity_id = $1 AND room_id = $2";
        let params = vec![
            JsValue::from_str(entity_id.as_str()),
            JsValue::from_str(room_id.as_str()),
        ];
        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn get_participants_for_entity(&self, entity_id: &UUID) -> Result<Vec<ParticipantInfo>> {
        let sql = "SELECT id, entity_id, room_id, user_state, created_at FROM participants WHERE entity_id = $1";
        let params = vec![JsValue::from_str(entity_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| self.parse_participant_info(&row))
            .collect())
    }

    async fn get_participants_for_room(&self, room_id: &UUID) -> Result<Vec<UUID>> {
        let sql = "SELECT entity_id FROM participants WHERE room_id = $1";
        let params = vec![JsValue::from_str(room_id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| self.get_uuid(&row, "entity_id"))
            .collect())
    }

    async fn is_room_participant(&self, room_id: &UUID, entity_id: &UUID) -> Result<bool> {
        let sql = "SELECT COUNT(*) as count FROM participants WHERE room_id = $1 AND entity_id = $2";
        let params = vec![
            JsValue::from_str(room_id.as_str()),
            JsValue::from_str(entity_id.as_str()),
        ];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        if let Some(row) = rows.first() {
            let count = self.get_f64(row, "count").unwrap_or(0.0);
            Ok(count > 0.0)
        } else {
            Ok(false)
        }
    }

    async fn add_participants_room(&self, entity_ids: &[UUID], room_id: &UUID) -> Result<bool> {
        for entity_id in entity_ids {
            let sql = r#"
                INSERT INTO participants (id, entity_id, room_id)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
            "#;

            let params = vec![
                JsValue::from_str(&UUID::new_v4().to_string()),
                JsValue::from_str(entity_id.as_str()),
                JsValue::from_str(room_id.as_str()),
            ];

            self.manager.query(sql, &params).await?;
        }
        Ok(true)
    }

    async fn get_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
    ) -> Result<Option<ParticipantUserState>> {
        let sql = "SELECT user_state FROM participants WHERE room_id = $1 AND entity_id = $2";
        let params = vec![
            JsValue::from_str(room_id.as_str()),
            JsValue::from_str(entity_id.as_str()),
        ];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.first().and_then(|row| {
            self.get_string(row, "user_state")
                .map(|s| ParticipantUserState { state: s })
        }))
    }

    async fn set_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
        state: Option<ParticipantUserState>,
    ) -> Result<()> {
        let sql = "UPDATE participants SET user_state = $3 WHERE room_id = $1 AND entity_id = $2";
        let params = vec![
            JsValue::from_str(room_id.as_str()),
            JsValue::from_str(entity_id.as_str()),
            state
                .map(|s| JsValue::from_str(&s.state))
                .unwrap_or(JsValue::NULL),
        ];
        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn create_relationship(&self, params: CreateRelationshipParams) -> Result<bool> {
        let tags = serde_json::to_string(&params.tags)?;
        let metadata = serde_json::to_string(&params.metadata)?;

        let sql = r#"
            INSERT INTO relationships (id, source_entity_id, target_entity_id, agent_id, tags, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
        "#;

        let js_params = vec![
            JsValue::from_str(&UUID::new_v4().to_string()),
            JsValue::from_str(params.source_entity_id.as_str()),
            JsValue::from_str(params.target_entity_id.as_str()),
            JsValue::from_str(&self.agent_id),
            JsValue::from_str(&tags),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &js_params).await?;
        Ok(true)
    }

    async fn update_relationship(&self, relationship: &Relationship) -> Result<()> {
        let tags = serde_json::to_string(&relationship.tags)?;
        let metadata = serde_json::to_string(&relationship.metadata)?;

        let sql = "UPDATE relationships SET tags = $2, metadata = $3 WHERE id = $1";
        let params = vec![
            JsValue::from_str(relationship.id.as_str()),
            JsValue::from_str(&tags),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn get_relationship(
        &self,
        params: GetRelationshipParams,
    ) -> Result<Option<Relationship>> {
        let sql = r#"
            SELECT id, source_entity_id, target_entity_id, agent_id, tags, metadata, created_at
            FROM relationships
            WHERE source_entity_id = $1 AND target_entity_id = $2
        "#;

        let js_params = vec![
            JsValue::from_str(params.source_entity_id.as_str()),
            JsValue::from_str(params.target_entity_id.as_str()),
        ];

        let result = self.manager.query(sql, &js_params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.first().and_then(|row| self.parse_relationship(row)))
    }

    async fn get_relationships(
        &self,
        params: GetRelationshipsParams,
    ) -> Result<Vec<Relationship>> {
        let sql = r#"
            SELECT id, source_entity_id, target_entity_id, agent_id, tags, metadata, created_at
            FROM relationships
            WHERE source_entity_id = $1 OR target_entity_id = $1
        "#;

        let js_params = vec![JsValue::from_str(params.entity_id.as_str())];
        let result = self.manager.query(sql, &js_params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| self.parse_relationship(&row))
            .collect())
    }

    async fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let sql = "SELECT value, expires_at FROM cache WHERE key = $1";
        let params = vec![JsValue::from_str(key)];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        if let Some(row) = rows.first() {
            if let Some(expires_str) = self.get_string(row, "expires_at") {
                if !expires_str.is_empty() {
                    self.delete_cache(key).await?;
                    return Ok(None);
                }
            }

            if let Some(value_str) = self.get_string(row, "value") {
                let value: T = serde_json::from_str(&value_str)?;
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    async fn set_cache<T: serde::Serialize + Send + Sync>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<bool> {
        let json = serde_json::to_string(value)?;

        let sql = r#"
            INSERT INTO cache (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = $2
        "#;

        let params = vec![JsValue::from_str(key), JsValue::from_str(&json)];
        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn delete_cache(&self, key: &str) -> Result<bool> {
        let sql = "DELETE FROM cache WHERE key = $1";
        let params = vec![JsValue::from_str(key)];
        self.manager.query(sql, &params).await?;
        Ok(true)
    }

    async fn create_task(&self, task: &Task) -> Result<UUID> {
        let id = task.id.clone().unwrap_or_else(UUID::new_v4);
        let tags = serde_json::to_string(&task.tags)?;
        let metadata = serde_json::to_string(&task.metadata)?;
        let status = task
            .status
            .as_ref()
            .map(|s| match s {
                TaskStatus::Pending => "pending",
                TaskStatus::InProgress => "in_progress",
                TaskStatus::Completed => "completed",
                TaskStatus::Failed => "failed",
                TaskStatus::Cancelled => "cancelled",
            })
            .unwrap_or("pending");

        let sql = r#"
            INSERT INTO tasks (id, name, description, room_id, entity_id, world_id, status, tags, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#;

        let params = vec![
            JsValue::from_str(id.as_str()),
            JsValue::from_str(&task.name),
            task.description
                .as_ref()
                .map(|d| JsValue::from_str(d))
                .unwrap_or(JsValue::NULL),
            task.room_id
                .as_ref()
                .map(|r| JsValue::from_str(r.as_str()))
                .unwrap_or(JsValue::NULL),
            task.entity_id
                .as_ref()
                .map(|e| JsValue::from_str(e.as_str()))
                .unwrap_or(JsValue::NULL),
            task.world_id
                .as_ref()
                .map(|w| JsValue::from_str(w.as_str()))
                .unwrap_or(JsValue::NULL),
            JsValue::from_str(status),
            JsValue::from_str(&tags),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(id)
    }

    async fn get_tasks(&self, params: GetTasksParams) -> Result<Vec<Task>> {
        let mut sql = String::from(
            "SELECT id, name, description, room_id, entity_id, world_id, status, tags, metadata, created_at, updated_at FROM tasks WHERE 1=1",
        );
        let mut js_params = vec![];
        let mut param_idx = 1;

        if let Some(room_id) = &params.room_id {
            sql.push_str(&format!(" AND room_id = ${}", param_idx));
            js_params.push(JsValue::from_str(room_id.as_str()));
            param_idx += 1;
        }
        if let Some(entity_id) = &params.entity_id {
            sql.push_str(&format!(" AND entity_id = ${}", param_idx));
            js_params.push(JsValue::from_str(entity_id.as_str()));
        }

        let result = self.manager.query(&sql, &js_params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_task(&row)).collect())
    }

    async fn get_task(&self, id: &UUID) -> Result<Option<Task>> {
        let sql = "SELECT id, name, description, room_id, entity_id, world_id, status, tags, metadata, created_at, updated_at FROM tasks WHERE id = $1";
        let params = vec![JsValue::from_str(id.as_str())];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.first().and_then(|row| self.parse_task(row)))
    }

    async fn get_tasks_by_name(&self, name: &str) -> Result<Vec<Task>> {
        let sql = "SELECT id, name, description, room_id, entity_id, world_id, status, tags, metadata, created_at, updated_at FROM tasks WHERE name = $1";
        let params = vec![JsValue::from_str(name)];
        let result = self.manager.query(sql, &params).await?;
        let rows = self.parse_rows(&result)?;

        Ok(rows.into_iter().filter_map(|row| self.parse_task(&row)).collect())
    }

    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()> {
        let tags = serde_json::to_string(&task.tags)?;
        let metadata = serde_json::to_string(&task.metadata)?;
        let status = task
            .status
            .as_ref()
            .map(|s| match s {
                TaskStatus::Pending => "pending",
                TaskStatus::InProgress => "in_progress",
                TaskStatus::Completed => "completed",
                TaskStatus::Failed => "failed",
                TaskStatus::Cancelled => "cancelled",
            })
            .unwrap_or("pending");

        let sql = r#"
            UPDATE tasks SET
                status = $2,
                tags = $3,
                metadata = $4,
                updated_at = now()
            WHERE id = $1
        "#;

        let params = vec![
            JsValue::from_str(id.as_str()),
            JsValue::from_str(status),
            JsValue::from_str(&tags),
            JsValue::from_str(&metadata),
        ];

        self.manager.query(sql, &params).await?;
        Ok(())
    }

    async fn delete_task(&self, id: &UUID) -> Result<()> {
        let sql = "DELETE FROM tasks WHERE id = $1";
        let params = vec![JsValue::from_str(id.as_str())];
        self.manager.query(sql, &params).await?;
        Ok(())
    }
}
