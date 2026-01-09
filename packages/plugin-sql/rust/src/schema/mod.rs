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

// Re-export all schemas
pub use agent::*;
pub use cache::*;
pub use component::*;
pub use embedding::*;
pub use entity::*;
pub use log::*;
pub use memory::*;
pub use participant::*;
pub use relationship::*;
pub use room::*;
pub use task::*;
pub use world::*;

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
