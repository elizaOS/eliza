#![allow(missing_docs)]

use anyhow::Result;
use async_trait::async_trait;
use elizaos::{
    Agent, Component, Entity, GetMemoriesParams, Log, Memory, Metadata, Relationship, Room,
    SearchMemoriesParams, Task, World, UUID,
};

#[cfg(feature = "native")]
use sqlx::PgPool;

/// Strongly-typed handle to an adapter's underlying connection.
///
/// This replaces `Box<dyn Any>` to avoid runtime downcasting and to keep adapter
/// connection access type-safe across targets.
#[derive(Clone, Debug)]
pub enum DatabaseConnection {
    /// A PostgreSQL connection pool (native targets).
    #[cfg(feature = "native")]
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

/// User participation state
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParticipantUserState {
    /// State string value
    pub state: String,
}

/// Participant info returned from database queries
#[derive(Clone, Debug)]
pub struct ParticipantInfo {
    /// Participant ID
    pub id: UUID,
    /// Entity ID
    pub entity_id: UUID,
    /// Room ID
    pub room_id: UUID,
    /// User state (optional)
    pub user_state: Option<String>,
    /// Created at timestamp
    pub created_at: Option<i64>,
}

/// Database adapter interface
///
/// This trait defines all the methods that a database adapter must implement
/// to work with elizaOS. It mirrors the TypeScript IDatabaseAdapter interface.
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait DatabaseAdapter: Send + Sync {
    // =========================================================================
    // Core Methods
    // =========================================================================

    /// Initialize database connection
    async fn init(&self) -> Result<()>;

    /// Initialize the adapter (alias for init)
    async fn initialize(&self, _config: Option<serde_json::Value>) -> Result<()> {
        self.init().await
    }

    /// Check if the database connection is ready
    async fn is_ready(&self) -> Result<bool>;

    /// Close database connection
    async fn close(&self) -> Result<()>;

    /// Get the underlying database connection
    async fn get_connection(&self) -> Result<DatabaseConnection>;

    // =========================================================================
    // Agent Methods
    // =========================================================================

    /// Get an agent by ID
    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>>;

    /// Get all agents
    async fn get_agents(&self) -> Result<Vec<Agent>>;

    /// Create a new agent
    async fn create_agent(&self, agent: &Agent) -> Result<bool>;

    /// Update an agent
    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool>;

    /// Delete an agent
    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool>;

    // =========================================================================
    // Entity Methods
    // =========================================================================

    /// Get entities by IDs
    async fn get_entities_by_ids(&self, entity_ids: &[UUID]) -> Result<Vec<Entity>>;

    /// Get entities for a room
    async fn get_entities_for_room(
        &self,
        room_id: &UUID,
        include_components: bool,
    ) -> Result<Vec<Entity>>;

    /// Create new entities
    async fn create_entities(&self, entities: &[Entity]) -> Result<bool>;

    /// Update an entity
    async fn update_entity(&self, entity: &Entity) -> Result<()>;

    // =========================================================================
    // Component Methods
    // =========================================================================

    /// Get a component by ID
    async fn get_component(
        &self,
        entity_id: &UUID,
        component_type: &str,
        world_id: Option<&UUID>,
        source_entity_id: Option<&UUID>,
    ) -> Result<Option<Component>>;

    /// Get all components for an entity
    async fn get_components(
        &self,
        entity_id: &UUID,
        world_id: Option<&UUID>,
        source_entity_id: Option<&UUID>,
    ) -> Result<Vec<Component>>;

    /// Create a component
    async fn create_component(&self, component: &Component) -> Result<bool>;

    /// Update a component
    async fn update_component(&self, component: &Component) -> Result<()>;

    /// Delete a component
    async fn delete_component(&self, component_id: &UUID) -> Result<()>;

    // =========================================================================
    // Memory Methods
    // =========================================================================

    /// Get memories matching criteria
    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>>;

    /// Get a memory by ID
    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>>;

    /// Get memories by IDs
    async fn get_memories_by_ids(
        &self,
        ids: &[UUID],
        table_name: Option<&str>,
    ) -> Result<Vec<Memory>>;

    /// Get memories by room IDs
    async fn get_memories_by_room_ids(
        &self,
        table_name: &str,
        room_ids: &[UUID],
        limit: Option<i32>,
    ) -> Result<Vec<Memory>>;

    /// Get cached embeddings
    async fn get_cached_embeddings(
        &self,
        params: GetCachedEmbeddingsParams,
    ) -> Result<Vec<EmbeddingSearchResult>>;

    /// Search memories by embedding
    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>>;

    /// Create a memory
    async fn create_memory(&self, memory: &Memory, table_name: &str, unique: bool) -> Result<UUID>;

    /// Update a memory
    async fn update_memory(&self, memory: &Memory) -> Result<bool>;

    /// Delete a memory
    async fn delete_memory(&self, memory_id: &UUID) -> Result<()>;

    /// Delete many memories
    async fn delete_many_memories(&self, memory_ids: &[UUID]) -> Result<()>;

    /// Delete all memories in a room
    async fn delete_all_memories(&self, room_id: &UUID, table_name: &str) -> Result<()>;

    /// Count memories in a room
    async fn count_memories(
        &self,
        room_id: &UUID,
        unique: bool,
        table_name: Option<&str>,
    ) -> Result<i64>;

    /// Ensure embedding dimension
    async fn ensure_embedding_dimension(&self, dimension: i32) -> Result<()>;

    /// Get memories by world ID
    async fn get_memories_by_world_id(
        &self,
        world_id: &UUID,
        count: Option<i32>,
        table_name: Option<&str>,
    ) -> Result<Vec<Memory>>;

    // =========================================================================
    // Logging Methods
    // =========================================================================

    /// Create a log entry
    async fn log(&self, params: LogParams) -> Result<()>;

    /// Get log entries
    async fn get_logs(&self, params: GetLogsParams) -> Result<Vec<Log>>;

    /// Delete a log entry
    async fn delete_log(&self, log_id: &UUID) -> Result<()>;

    // =========================================================================
    // World Methods
    // =========================================================================

    /// Create a world
    async fn create_world(&self, world: &World) -> Result<UUID>;

    /// Get a world by ID
    async fn get_world(&self, id: &UUID) -> Result<Option<World>>;

    /// Remove a world
    async fn remove_world(&self, id: &UUID) -> Result<()>;

    /// Get all worlds
    async fn get_all_worlds(&self) -> Result<Vec<World>>;

    /// Update a world
    async fn update_world(&self, world: &World) -> Result<()>;

    // =========================================================================
    // Room Methods
    // =========================================================================

    /// Get rooms by IDs
    async fn get_rooms_by_ids(&self, room_ids: &[UUID]) -> Result<Vec<Room>>;

    /// Create rooms
    async fn create_rooms(&self, rooms: &[Room]) -> Result<Vec<UUID>>;

    /// Delete a room
    async fn delete_room(&self, room_id: &UUID) -> Result<()>;

    /// Delete rooms by world ID
    async fn delete_rooms_by_world_id(&self, world_id: &UUID) -> Result<()>;

    /// Update a room
    async fn update_room(&self, room: &Room) -> Result<()>;

    /// Get rooms by world
    async fn get_rooms_by_world(&self, world_id: &UUID) -> Result<Vec<Room>>;

    // =========================================================================
    // Participant Methods
    // =========================================================================

    /// Get rooms for a participant
    async fn get_rooms_for_participant(&self, entity_id: &UUID) -> Result<Vec<UUID>>;

    /// Get rooms for participants
    async fn get_rooms_for_participants(&self, user_ids: &[UUID]) -> Result<Vec<UUID>>;

    /// Remove a participant from a room
    async fn remove_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool>;

    /// Get participants for an entity
    async fn get_participants_for_entity(&self, entity_id: &UUID) -> Result<Vec<ParticipantInfo>>;

    /// Get participants for a room
    async fn get_participants_for_room(&self, room_id: &UUID) -> Result<Vec<UUID>>;

    /// Check if an entity is a participant in a room
    async fn is_room_participant(&self, room_id: &UUID, entity_id: &UUID) -> Result<bool>;

    /// Add participants to a room
    async fn add_participants_room(&self, entity_ids: &[UUID], room_id: &UUID) -> Result<bool>;

    /// Get participant user state
    async fn get_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
    ) -> Result<Option<ParticipantUserState>>;

    /// Set participant user state
    async fn set_participant_user_state(
        &self,
        room_id: &UUID,
        entity_id: &UUID,
        state: Option<ParticipantUserState>,
    ) -> Result<()>;

    // =========================================================================
    // Relationship Methods
    // =========================================================================

    /// Create a relationship
    async fn create_relationship(&self, params: CreateRelationshipParams) -> Result<bool>;

    /// Update a relationship
    async fn update_relationship(&self, relationship: &Relationship) -> Result<()>;

    /// Get a relationship
    async fn get_relationship(&self, params: GetRelationshipParams)
        -> Result<Option<Relationship>>;

    /// Get relationships for an entity
    async fn get_relationships(&self, params: GetRelationshipsParams) -> Result<Vec<Relationship>>;

    // =========================================================================
    // Cache Methods
    // =========================================================================

    /// Get a cached value
    async fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>>;

    /// Set a cached value
    async fn set_cache<T: serde::Serialize + Send + Sync>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<bool>;

    /// Delete a cached value
    async fn delete_cache(&self, key: &str) -> Result<bool>;

    // =========================================================================
    // Task Methods
    // =========================================================================

    /// Create a task
    async fn create_task(&self, task: &Task) -> Result<UUID>;

    /// Get tasks
    async fn get_tasks(&self, params: GetTasksParams) -> Result<Vec<Task>>;

    /// Get a task by ID
    async fn get_task(&self, id: &UUID) -> Result<Option<Task>>;

    /// Get tasks by name
    async fn get_tasks_by_name(&self, name: &str) -> Result<Vec<Task>>;

    /// Update a task
    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()>;

    /// Delete a task
    async fn delete_task(&self, id: &UUID) -> Result<()>;
}
