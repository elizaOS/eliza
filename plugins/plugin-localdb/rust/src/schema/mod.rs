#![allow(missing_docs)]

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

pub mod table_names {
    pub const AGENTS: &str = "agents";
    pub const MEMORIES: &str = "memories";
    pub const EMBEDDINGS: &str = "embeddings";
    pub const ENTITIES: &str = "entities";
    pub const ROOMS: &str = "rooms";
    pub const WORLDS: &str = "worlds";
    pub const COMPONENTS: &str = "components";
    pub const PARTICIPANTS: &str = "participants";
    pub const RELATIONSHIPS: &str = "relationships";
    pub const TASKS: &str = "tasks";
    pub const LOGS: &str = "logs";
    pub const CACHE: &str = "cache";
}
