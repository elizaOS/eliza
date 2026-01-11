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

// Import directly from submodules:
// - agent::* for agent schemas
// - cache::* for cache schemas
// - component::* for component schemas
// - embedding::* for embedding schemas
// - entity::* for entity schemas
// - log::* for log schemas
// - memory::* for memory schemas
// - participant::* for participant schemas
// - relationship::* for relationship schemas
// - room::* for room schemas
// - task::* for task schemas
// - world::* for world schemas

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
