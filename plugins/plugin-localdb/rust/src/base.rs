#![allow(missing_docs)]

use anyhow::Result;
use async_trait::async_trait;
use elizaos::{
    Agent, Component, Entity, GetMemoriesParams, Log, Memory, Metadata, Relationship, Room,
    SearchMemoriesParams, Task, World, UUID,
};

#[cfg(not(feature = "wasm"))]
use sqlx::PgPool;

/// Strongly-typed handle to an adapter's underlying connection.
///
/// This replaces `Box<dyn Any>` to avoid runtime downcasting and to keep adapter
/// connection access type-safe across targets.
#[derive(Clone, Debug)]
pub enum DatabaseConnection {
    /// A PostgreSQL connection pool (native targets).
    #[cfg(not(feature = "wasm"))]
    Postgres(PgPool),
    /// No underlying connection is exposed (e.g. WASM adapters).
    None,
}

#[derive(Clone, Debug)]
pub struct EmbeddingSearchResult {
    pub id: elizaos::UUID,
    pub embedding: Vec<f32>,
    pub similarity: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct GetCachedEmbeddingsParams {
    pub table_name: String,
    pub query_threshold: Option<f64>,
    pub query_input: Option<String>,
    pub match_count: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct LogParams {
    pub body: serde_json::Value,
    pub entity_id: UUID,
    pub room_id: Option<UUID>,
    pub log_type: String,
}

#[derive(Clone, Debug, Default)]
pub struct GetLogsParams {
    pub entity_id: Option<UUID>,
    pub room_id: Option<UUID>,
    pub log_type: Option<String>,
    pub count: Option<i32>,
    pub offset: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct CreateRelationshipParams {
    pub source_entity_id: UUID,
    pub target_entity_id: UUID,
    pub tags: Option<Vec<String>>,
    pub metadata: Option<Metadata>,
}

#[derive(Clone, Debug)]
pub struct GetRelationshipParams {
    pub source_entity_id: UUID,
    pub target_entity_id: UUID,
}

#[derive(Clone, Debug)]
pub struct GetRelationshipsParams {
    pub entity_id: UUID,
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub struct GetTasksParams {
    pub room_id: Option<UUID>,
    pub tags: Option<Vec<String>>,
    pub entity_id: Option<UUID>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParticipantUserState {
    pub state: String,
}

#[derive(Clone, Debug)]
pub struct ParticipantInfo {
    pub id: UUID,
    pub entity_id: UUID,
    pub room_id: UUID,
    pub user_state: Option<String>,
    pub created_at: Option<i64>,
}

#[async_trait]
pub trait DatabaseAdapter: Send + Sync {
    async fn init(&self) -> Result<()>;

    async fn initialize(&self, config: Option<serde_json::Value>) -> Result<()> {
        self.init().await
    }

    async fn is_ready(&self) -> Result<bool>;

    async fn close(&self) -> Result<()>;

    async fn get_connection(&self) -> Result<DatabaseConnection>;

    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>>;

    async fn get_agents(&self) -> Result<Vec<Agent>>;

    async fn create_agent(&self, agent: &Agent) -> Result<bool>;

    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool>;

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool>;

    async fn get_entities_by_ids(&self, entity_ids: &[UUID]) -> Result<Vec<Entity>>;

    async fn get_entities_for_room(
        &self,
        room_id: &UUID,
        include_components: bool,
    ) -> Result<Vec<Entity>>;

    async fn create_entities(&self, entities: &[Entity]) -> Result<bool>;

    async fn update_entity(&self, entity: &Entity) -> Result<()>;

    async fn get_component(
        &self,
        entity_id: &UUID,
        component_type: &str,
        world_id: Option<&UUID>,
        source_entity_id: Option<&UUID>,
    ) -> Result<Option<Component>>;

    async fn get_components(
        &self,
        entity_id: &UUID,
        world_id: Option<&UUID>,
        source_entity_id: Option<&UUID>,
    ) -> Result<Vec<Component>>;

    async fn create_component(&self, component: &Component) -> Result<bool>;

    async fn update_component(&self, component: &Component) -> Result<()>;

    async fn delete_component(&self, component_id: &UUID) -> Result<()>;

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>>;

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>>;

    async fn get_memories_by_ids(
        &self,
        ids: &[UUID],
        table_name: Option<&str>,
    ) -> Result<Vec<Memory>>;

    async fn get_memories_by_room_ids(
        &self,
        table_name: &str,
        room_ids: &[UUID],
        limit: Option<i32>,
    ) -> Result<Vec<Memory>>;

    async fn get_cached_embeddings(
        &self,
        params: GetCachedEmbeddingsParams,
    ) -> Result<Vec<EmbeddingSearchResult>>;

    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>>;

    async fn create_memory(&self, memory: &Memory, table_name: &str, unique: bool) -> Result<UUID>;

    async fn update_memory(&self, memory: &Memory) -> Result<bool>;

    async fn delete_memory(&self, memory_id: &UUID) -> Result<()>;

    async fn delete_many_memories(&self, memory_ids: &[UUID]) -> Result<()>;

    async fn delete_all_memories(&self, room_id: &UUID, table_name: &str) -> Result<()>;

    async fn count_memories(
        &self,
        room_id: &UUID,
        unique: bool,
        table_name: Option<&str>,
    ) -> Result<i64>;

    async fn ensure_embedding_dimension(&self, dimension: i32) -> Result<()>;

    async fn get_memories_by_world_id(
        &self,
        world_id: &UUID,
        count: Option<i32>,
        table_name: Option<&str>,
    ) -> Result<Vec<Memory>>;

    async fn log(&self, params: LogParams) -> Result<()>;

    async fn get_logs(&self, params: GetLogsParams) -> Result<Vec<Log>>;

    async fn delete_log(&self, log_id: &UUID) -> Result<()>;

    async fn create_world(&self, world: &World) -> Result<UUID>;

    async fn get_world(&self, id: &UUID) -> Result<Option<World>>;

    async fn remove_world(&self, id: &UUID) -> Result<()>;

    async fn get_all_worlds(&self) -> Result<Vec<World>>;

    async fn update_world(&self, world: &World) -> Result<()>;

    async fn get_rooms_by_ids(&self, room_ids: &[UUID]) -> Result<Vec<Room>>;

    async fn create_rooms(&self, rooms: &[Room]) -> Result<Vec<UUID>>;

    async fn delete_room(&self, room_id: &UUID) -> Result<()>;

    async fn delete_rooms_by_world_id(&self, world_id: &UUID) -> Result<()>;

    async fn update_room(&self, room: &Room) -> Result<()>;

    async fn get_rooms_by_world(&self, world_id: &UUID) -> Result<Vec<Room>>;

    async fn get_rooms_for_participant(&self, entity_id: &UUID) -> Result<Vec<UUID>>;

    async fn get_rooms_for_participants(&self, user_ids: &[UUID]) -> Result<Vec<UUID>>;

    async fn remove_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool>;

    async fn get_participants_for_entity(&self, entity_id: &UUID) -> Result<Vec<ParticipantInfo>>;

    async fn get_participants_for_room(&self, room_id: &UUID) -> Result<Vec<UUID>>;

    async fn is_room_participant(&self, room_id: &UUID, entity_id: &UUID) -> Result<bool>;

    async fn add_participants_room(&self, entity_ids: &[UUID], room_id: &UUID) -> Result<bool>;

    async fn get_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
    ) -> Result<Option<ParticipantUserState>>;

    async fn set_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
        state: Option<ParticipantUserState>,
    ) -> Result<()>;

    async fn create_relationship(&self, params: CreateRelationshipParams) -> Result<bool>;

    async fn update_relationship(&self, relationship: &Relationship) -> Result<()>;

    async fn get_relationship(&self, params: GetRelationshipParams)
        -> Result<Option<Relationship>>;

    async fn get_relationships(&self, params: GetRelationshipsParams) -> Result<Vec<Relationship>>;

    async fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>>;

    async fn set_cache<T: serde::Serialize + Send + Sync>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<bool>;

    async fn delete_cache(&self, key: &str) -> Result<bool>;

    async fn create_task(&self, task: &Task) -> Result<UUID>;

    async fn get_tasks(&self, params: GetTasksParams) -> Result<Vec<Task>>;

    async fn get_task(&self, id: &UUID) -> Result<Option<Task>>;

    async fn get_tasks_by_name(&self, name: &str) -> Result<Vec<Task>>;

    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()>;

    async fn delete_task(&self, id: &UUID) -> Result<()>;
}
