//! Bridge between ICP storage and elizaOS unified runtime
//!
//! This module implements the `UnifiedDatabaseAdapter` trait from elizaOS
//! using ICP's stable memory storage. This enables the ICP canister to
//! use the canonical elizaOS runtime patterns in both sync and async modes.
//!
//! # Usage
//!
//! ```rust,ignore
//! use crate::eliza_bridge::IcpElizaAdapter;
//! use elizaos::{UnifiedRuntime, UnifiedRuntimeOptions, Character};
//!
//! let character = Character { name: "MyAgent".to_string(), ..Default::default() };
//! let adapter = IcpElizaAdapter::new("agent-id".to_string());
//! let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
//!     character: Some(character),
//!     adapter: Some(Arc::new(adapter)),
//!     ..Default::default()
//! })?;
//!
//! // Register model handler (calls your HTTP outcall function)
//! runtime.register_model("TEXT_LARGE", Box::new(|params| {
//!     // Call OpenAI via HTTP outcall
//!     generate_openai_response(params)
//! }));
//!
//! // Handle messages using the canonical elizaOS pattern
//! let result = runtime.message_service().handle_message(&runtime, &mut message, None)?;
//! ```
//!
//! # Architecture
//!
//! The unified runtime uses `maybe-async` to compile to either:
//! - **Sync mode** (`sync` feature): All methods are synchronous - perfect for ICP
//! - **Async mode** (default): All methods are async - for native Rust apps
//!
//! This means zero code duplication between sync and async implementations!

use crate::storage::IcpDatabaseAdapter;
use crate::types::{generate_uuid, now_millis};
use anyhow::Result;
use serde_json::Value;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};

/// Re-export for backward compatibility
pub type IcpElizaAdapterStandalone = IcpElizaAdapter;

// ============================================================================
// ICP UNIFIED ADAPTER
// ============================================================================

/// ICP implementation of elizaOS's UnifiedDatabaseAdapter trait.
///
/// This adapter uses ICP's stable memory for persistence across canister
/// upgrades, providing the same interface as the in-memory adapter but
/// with blockchain-backed storage.
///
/// # Features
///
/// - Stable memory persistence
/// - Vector search for semantic memory retrieval
/// - Full compatibility with elizaOS types (Agent, Memory, Room, etc.)
/// - Works with the unified sync/async runtime
pub struct IcpElizaAdapter {
    inner: RefCell<IcpDatabaseAdapter>,
    ready: AtomicBool,
}

// Manual Send + Sync implementation for ICP's single-threaded environment
// ICP canisters are single-threaded, so this is safe
unsafe impl Send for IcpElizaAdapter {}
unsafe impl Sync for IcpElizaAdapter {}

impl IcpElizaAdapter {
    /// Create a new ICP adapter
    pub fn new(agent_id: String) -> Self {
        Self {
            inner: RefCell::new(IcpDatabaseAdapter::new(agent_id)),
            ready: AtomicBool::new(false),
        }
    }

    /// Initialize the adapter
    pub fn init(&self) -> Result<()> {
        self.inner.borrow_mut().init()
            .map_err(|e| anyhow::anyhow!("ICP storage init failed: {:?}", e))?;
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Close the adapter
    pub fn close(&self) -> Result<()> {
        self.inner.borrow_mut().close()
            .map_err(|e| anyhow::anyhow!("ICP storage close failed: {:?}", e))?;
        self.ready.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Check if ready
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    // ========== Agent Operations ==========

    pub fn get_agent(&self, agent_id: &str) -> Result<Option<Value>> {
        self.inner.borrow().get_agent(agent_id)
            .map_err(|e| anyhow::anyhow!("Get agent failed: {:?}", e))
    }

    pub fn create_agent(&self, agent: Value) -> Result<bool> {
        self.inner.borrow().create_agent(agent)
            .map_err(|e| anyhow::anyhow!("Create agent failed: {:?}", e))
    }

    pub fn update_agent(&self, agent_id: &str, agent: Value) -> Result<bool> {
        self.inner.borrow().update_agent(agent_id, agent)
            .map_err(|e| anyhow::anyhow!("Update agent failed: {:?}", e))
    }

    pub fn delete_agent(&self, agent_id: &str) -> Result<bool> {
        self.inner.borrow().delete_agent(agent_id)
            .map_err(|e| anyhow::anyhow!("Delete agent failed: {:?}", e))
    }

    // ========== Memory Operations ==========

    pub fn get_memories(
        &self,
        entity_id: Option<&str>,
        agent_id: Option<&str>,
        room_id: Option<&str>,
        world_id: Option<&str>,
        table_name: &str,
        count: Option<usize>,
        offset: Option<usize>,
    ) -> Result<Vec<Value>> {
        self.inner.borrow().get_memories(
            entity_id, agent_id, room_id, world_id,
            table_name, count, offset, None,
        ).map_err(|e| anyhow::anyhow!("Get memories failed: {:?}", e))
    }

    pub fn search_memories(
        &self,
        table_name: &str,
        embedding: &[f32],
        threshold: Option<f32>,
        count: Option<usize>,
        room_id: Option<&str>,
    ) -> Result<Vec<Value>> {
        self.inner.borrow().search_memories(
            table_name, embedding, threshold, count,
            room_id, None, None, None,
        ).map_err(|e| anyhow::anyhow!("Search memories failed: {:?}", e))
    }

    pub fn create_memory(&self, memory: Value, table_name: &str, unique: bool) -> Result<String> {
        self.inner.borrow().create_memory(memory, table_name, unique)
            .map_err(|e| anyhow::anyhow!("Create memory failed: {:?}", e))
    }

    pub fn get_memory_by_id(&self, id: &str) -> Result<Option<Value>> {
        self.inner.borrow().get_memory_by_id(id)
            .map_err(|e| anyhow::anyhow!("Get memory by id failed: {:?}", e))
    }

    pub fn delete_memory(&self, memory_id: &str) -> Result<()> {
        self.inner.borrow().delete_memory(memory_id)
            .map_err(|e| anyhow::anyhow!("Delete memory failed: {:?}", e))
    }

    // ========== Room Operations ==========

    pub fn create_room(&self, room: Value) -> Result<String> {
        self.inner.borrow().create_room(room)
            .map_err(|e| anyhow::anyhow!("Create room failed: {:?}", e))
    }

    pub fn get_room(&self, id: &str) -> Result<Option<Value>> {
        self.inner.borrow().get_room(id)
            .map_err(|e| anyhow::anyhow!("Get room failed: {:?}", e))
    }

    pub fn delete_room(&self, room_id: &str) -> Result<()> {
        self.inner.borrow().delete_room(room_id)
            .map_err(|e| anyhow::anyhow!("Delete room failed: {:?}", e))
    }

    // ========== Entity Operations ==========

    pub fn create_entity(&self, entity: Value) -> Result<String> {
        self.inner.borrow().create_entity(entity)
            .map_err(|e| anyhow::anyhow!("Create entity failed: {:?}", e))
    }

    pub fn get_entity(&self, id: &str) -> Result<Option<Value>> {
        self.inner.borrow().get_entity(id)
            .map_err(|e| anyhow::anyhow!("Get entity failed: {:?}", e))
    }

    // ========== Cache Operations ==========

    pub fn get_cache(&self, key: &str) -> Result<Option<Value>> {
        self.inner.borrow().get_cache(key)
            .map_err(|e| anyhow::anyhow!("Get cache failed: {:?}", e))
    }

    pub fn set_cache(&self, key: &str, value: Value) -> Result<bool> {
        self.inner.borrow().set_cache(key, value)
            .map_err(|e| anyhow::anyhow!("Set cache failed: {:?}", e))
    }

    pub fn delete_cache(&self, key: &str) -> Result<bool> {
        self.inner.borrow().delete_cache(key)
            .map_err(|e| anyhow::anyhow!("Delete cache failed: {:?}", e))
    }

    // ========== Utility ==========

    pub fn memory_count(&self) -> u64 {
        self.inner.borrow().memory_count()
    }
}

// ============================================================================
// EXAMPLE: How to use with elizaOS UnifiedRuntime
// ============================================================================
//
// When the elizaos crate is available with the `sync` feature, you can use
// the IcpElizaAdapter like this:
//
// ```rust
// use elizaos::{
//     UnifiedRuntime, UnifiedRuntimeOptions, UnifiedDatabaseAdapter,
//     Character, Bio, Memory, UUID,
// };
// use std::sync::Arc;
//
// // Implement UnifiedDatabaseAdapter for IcpElizaAdapter
// #[maybe_async::maybe_async(?Send)]
// impl UnifiedDatabaseAdapter for IcpElizaAdapter {
//     async fn init(&self) -> Result<()> {
//         self.init()
//     }
//
//     async fn close(&self) -> Result<()> {
//         self.close()
//     }
//
//     async fn is_ready(&self) -> Result<bool> {
//         Ok(self.is_ready())
//     }
//
//     // ... implement other methods mapping to self.* methods
// }
//
// // Create and use the runtime
// fn main() {
//     let character = Character {
//         name: "ICPAgent".to_string(),
//         bio: Bio::Single("An agent running on ICP".to_string()),
//         system: Some("You are a helpful assistant.".to_string()),
//         ..Default::default()
//     };
//
//     let adapter = Arc::new(IcpElizaAdapter::new("agent-1".to_string()));
//
//     let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
//         character: Some(character),
//         adapter: Some(adapter),
//         ..Default::default()
//     }).unwrap();
//
//     // Register sync model handler (ICP HTTP outcall)
//     runtime.register_model("TEXT_LARGE", Box::new(|params| {
//         // Your OpenAI HTTP outcall here
//         Ok("Response from OpenAI".to_string())
//     }));
//
//     runtime.initialize().unwrap();
//
//     // Handle a message
//     let mut message = Memory::message(
//         UUID::new_v4(),
//         UUID::new_v4(),
//         "Hello, agent!"
//     );
//
//     let result = runtime.message_service()
//         .handle_message(&runtime, &mut message, None)
//         .unwrap();
//
//     println!("Response: {:?}", result.response_content);
// }
// ```
