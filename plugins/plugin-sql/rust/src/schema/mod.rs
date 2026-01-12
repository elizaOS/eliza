#![allow(missing_docs)]
//! Database schema definitions for elizaOS
//!
//! This module contains the schema definitions for all database tables.

pub mod agent;
pub mod cache;
pub mod component;
pub mod embedding;
pub mod entity;
pub mod log;
pub mod memory;
pub mod participant;
pub mod relationship;
pub mod room;
pub mod task;
pub mod world;

// Re-export record types for convenience
pub use agent::AgentRecord;
pub use component::ComponentRecord;
pub use embedding::DEFAULT_DIMENSION;
pub use entity::EntityRecord;
pub use log::LogRecord;
pub use memory::MemoryRecord;
pub use participant::ParticipantRecord;
pub use relationship::RelationshipRecord;
pub use room::RoomRecord;
pub use task::TaskRecord;
pub use world::WorldRecord;

/// Table names used in the database
pub mod table_names {
    /// Agents table
    pub const AGENTS: &str = "agents";
    /// Memories table
    pub const MEMORIES: &str = "memories";
    /// Embeddings table
    pub const EMBEDDINGS: &str = "embeddings";
    /// Entities table
    pub const ENTITIES: &str = "entities";
    /// Rooms table
    pub const ROOMS: &str = "rooms";
    /// Worlds table
    pub const WORLDS: &str = "worlds";
    /// Components table
    pub const COMPONENTS: &str = "components";
    /// Participants table
    pub const PARTICIPANTS: &str = "participants";
    /// Relationships table
    pub const RELATIONSHIPS: &str = "relationships";
    /// Tasks table
    pub const TASKS: &str = "tasks";
    /// Logs table
    pub const LOGS: &str = "logs";
    /// Cache table
    pub const CACHE: &str = "cache";
}
