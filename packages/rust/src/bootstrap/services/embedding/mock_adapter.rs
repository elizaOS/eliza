use crate::runtime::DatabaseAdapter;
use crate::types::database::{GetMemoriesParams, SearchMemoriesParams};
use crate::types::memory::Memory;
use crate::types::primitives::UUID;
use crate::types::{Entity, Room, Task, World};
use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct MockDatabaseAdapter {
    pub memories: Mutex<HashMap<String, Memory>>,
}

#[async_trait]
impl DatabaseAdapter for MockDatabaseAdapter {
    async fn init(&self) -> Result<()> {
        Ok(())
    }
    async fn close(&self) -> Result<()> {
        Ok(())
    }
    async fn is_ready(&self) -> Result<bool> {
        Ok(true)
    }
    async fn get_agent(&self, _agent_id: &UUID) -> Result<Option<crate::types::agent::Agent>> {
        Ok(None)
    }
    async fn create_agent(&self, _agent: &crate::types::agent::Agent) -> Result<bool> {
        Ok(true)
    }
    async fn update_agent(
        &self,
        _agent_id: &UUID,
        _agent: &crate::types::agent::Agent,
    ) -> Result<bool> {
        Ok(true)
    }
    async fn delete_agent(&self, _agent_id: &UUID) -> Result<bool> {
        Ok(true)
    }
    async fn get_memories(&self, _params: GetMemoriesParams) -> Result<Vec<Memory>> {
        Ok(vec![])
    }
    async fn search_memories(&self, _params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        Ok(vec![])
    }

    async fn create_memory(&self, memory: &Memory, _table_name: &str) -> Result<UUID> {
        let mut memories = self.memories.lock().unwrap();
        let id = memory.id.clone().unwrap_or_else(UUID::new_v4);
        let mut new_memory = memory.clone();
        new_memory.id = Some(id.clone());
        memories.insert(id.as_str().to_string(), new_memory);
        Ok(id)
    }

    async fn update_memory(&self, memory: &Memory) -> Result<bool> {
        let mut memories = self.memories.lock().unwrap();
        if let Some(id) = &memory.id {
            memories.insert(id.as_str().to_string(), memory.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn delete_memory(&self, _memory_id: &UUID) -> Result<()> {
        Ok(())
    }

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>> {
        let memories = self.memories.lock().unwrap();
        Ok(memories.get(id.as_str()).cloned())
    }

    async fn create_world(&self, world: &World) -> Result<UUID> {
        Ok(world.id.clone())
    }
    async fn get_world(&self, _id: &UUID) -> Result<Option<World>> {
        Ok(None)
    }
    async fn create_room(&self, room: &Room) -> Result<UUID> {
        Ok(room.id.clone())
    }
    async fn get_room(&self, _id: &UUID) -> Result<Option<Room>> {
        Ok(None)
    }
    async fn create_entity(&self, _entity: &Entity) -> Result<bool> {
        Ok(true)
    }
    async fn get_entity(&self, _id: &UUID) -> Result<Option<Entity>> {
        Ok(None)
    }
    async fn add_participant(&self, _entity_id: &UUID, _room_id: &UUID) -> Result<bool> {
        Ok(true)
    }
    async fn create_task(&self, task: &Task) -> Result<UUID> {
        Ok(task.id.clone().unwrap_or_default())
    }
    async fn get_task(&self, _id: &UUID) -> Result<Option<Task>> {
        Ok(None)
    }
    async fn update_task(&self, _id: &UUID, _task: &Task) -> Result<()> {
        Ok(())
    }
    async fn delete_task(&self, _id: &UUID) -> Result<()> {
        Ok(())
    }
}
