#![allow(missing_docs)]

use async_trait::async_trait;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::config::MemoryConfig;
use crate::error::{MemoryError, Result};
use crate::types::{LongTermMemory, LongTermMemoryCategory, SessionSummary};

/// Database adapter trait for memory operations.
#[async_trait]
pub trait DatabaseAdapter: Send + Sync {
    /// Insert a record into the database.
    async fn insert(&self, table: &str, data: serde_json::Value) -> Result<()>;

    /// Select records from the database.
    async fn select(
        &self,
        table: &str,
        conditions: serde_json::Value,
        order_by: Option<Vec<(&str, &str)>>,
        limit: Option<i32>,
    ) -> Result<Vec<serde_json::Value>>;

    /// Update records in the database.
    async fn update(
        &self,
        table: &str,
        data: serde_json::Value,
        conditions: serde_json::Value,
    ) -> Result<()>;

    /// Delete records from the database.
    async fn delete(&self, table: &str, conditions: serde_json::Value) -> Result<()>;
}

/// Cache adapter trait for caching operations.
#[async_trait]
pub trait CacheAdapter: Send + Sync {
    /// Get a value from cache.
    async fn get(&self, key: &str) -> Result<Option<serde_json::Value>>;

    /// Set a value in cache.
    async fn set(&self, key: &str, value: serde_json::Value) -> Result<()>;
}

pub struct MemoryService {
    config: RwLock<MemoryConfig>,
    agent_id: Option<Uuid>,
    db: Option<Arc<dyn DatabaseAdapter>>,
    cache: Option<Arc<dyn CacheAdapter>>,
    session_message_counts: RwLock<HashMap<Uuid, i32>>,
    last_extraction_checkpoints: RwLock<HashMap<String, i32>>,
}

impl MemoryService {
    pub const SERVICE_TYPE: &'static str = "memory";

    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Memory management with short-term summarization and long-term persistent facts";

    pub fn new(config: MemoryConfig) -> Self {
        Self {
            config: RwLock::new(config),
            agent_id: None,
            db: None,
            cache: None,
            session_message_counts: RwLock::new(HashMap::new()),
            last_extraction_checkpoints: RwLock::new(HashMap::new()),
        }
    }

    pub fn with_adapters(
        config: MemoryConfig,
        agent_id: Uuid,
        db: Arc<dyn DatabaseAdapter>,
        cache: Option<Arc<dyn CacheAdapter>>,
    ) -> Self {
        Self {
            config: RwLock::new(config),
            agent_id: Some(agent_id),
            db: Some(db),
            cache,
            session_message_counts: RwLock::new(HashMap::new()),
            last_extraction_checkpoints: RwLock::new(HashMap::new()),
        }
    }

    pub async fn get_config(&self) -> MemoryConfig {
        self.config.read().await.clone()
    }

    pub async fn update_config<F>(&self, update_fn: F)
    where
        F: FnOnce(&mut MemoryConfig),
    {
        let mut config = self.config.write().await;
        update_fn(&mut config);
    }

    pub async fn increment_message_count(&self, room_id: Uuid) -> i32 {
        let mut counts = self.session_message_counts.write().await;
        let current = counts.get(&room_id).copied().unwrap_or(0);
        let new_count = current + 1;
        counts.insert(room_id, new_count);
        new_count
    }

    pub async fn reset_message_count(&self, room_id: Uuid) {
        let mut counts = self.session_message_counts.write().await;
        counts.insert(room_id, 0);
    }

    fn get_extraction_key(entity_id: Uuid, room_id: Uuid) -> String {
        format!("memory:extraction:{}:{}", entity_id, room_id)
    }

    pub async fn get_last_extraction_checkpoint(
        &self,
        entity_id: Uuid,
        room_id: Uuid,
    ) -> Result<i32> {
        let key = Self::get_extraction_key(entity_id, room_id);

        {
            let checkpoints = self.last_extraction_checkpoints.read().await;
            if let Some(&count) = checkpoints.get(&key) {
                return Ok(count);
            }
        }

        if let Some(cache) = &self.cache {
            match cache.get(&key).await {
                Ok(Some(value)) => {
                    if let Some(count) = value.as_i64() {
                        let count = count as i32;
                        let mut checkpoints = self.last_extraction_checkpoints.write().await;
                        checkpoints.insert(key, count);
                        return Ok(count);
                    }
                }
                Err(e) => {
                    warn!("Failed to get extraction checkpoint from cache: {}", e);
                }
                _ => {}
            }
        }

        Ok(0)
    }

    pub async fn set_last_extraction_checkpoint(
        &self,
        entity_id: Uuid,
        room_id: Uuid,
        message_count: i32,
    ) -> Result<()> {
        let key = Self::get_extraction_key(entity_id, room_id);

        {
            let mut checkpoints = self.last_extraction_checkpoints.write().await;
            checkpoints.insert(key.clone(), message_count);
        }

        if let Some(cache) = &self.cache {
            if let Err(e) = cache.set(&key, serde_json::json!(message_count)).await {
                error!("Failed to persist extraction checkpoint: {}", e);
            } else {
                debug!(
                    "Set extraction checkpoint for {} in room {} at count {}",
                    entity_id, room_id, message_count
                );
            }
        }

        Ok(())
    }

    pub async fn should_run_extraction(
        &self,
        entity_id: Uuid,
        room_id: Uuid,
        current_message_count: i32,
    ) -> Result<bool> {
        let config = self.config.read().await;
        let threshold = config.long_term_extraction_threshold;
        let interval = config.long_term_extraction_interval;

        if current_message_count < threshold {
            return Ok(false);
        }

        let last_checkpoint = self
            .get_last_extraction_checkpoint(entity_id, room_id)
            .await?;
        let current_checkpoint = (current_message_count / interval) * interval;
        let should_run = current_message_count >= threshold && current_checkpoint > last_checkpoint;

        debug!(
            "Extraction check: count={}, threshold={}, interval={}, last_checkpoint={}, current_checkpoint={}, should_run={}",
            current_message_count, threshold, interval, last_checkpoint, current_checkpoint, should_run
        );

        Ok(should_run)
    }

    /// Store a long-term memory.
    #[allow(clippy::too_many_arguments)]
    pub async fn store_long_term_memory(
        &self,
        agent_id: Uuid,
        entity_id: Uuid,
        category: LongTermMemoryCategory,
        content: String,
        confidence: f64,
        source: Option<String>,
        metadata: Option<serde_json::Value>,
        embedding: Option<Vec<f32>>,
    ) -> Result<LongTermMemory> {
        let now = Utc::now();
        let id = Uuid::new_v4();

        let memory = LongTermMemory {
            id,
            agent_id,
            entity_id,
            category,
            content: content.clone(),
            metadata: metadata.clone().unwrap_or(serde_json::json!({})),
            embedding: embedding.clone(),
            confidence,
            source: source.clone(),
            created_at: now,
            updated_at: now,
            last_accessed_at: None,
            access_count: 0,
            similarity: None,
        };

        if let Some(db) = &self.db {
            db.insert(
                "long_term_memories",
                serde_json::json!({
                    "id": id.to_string(),
                    "agent_id": agent_id.to_string(),
                    "entity_id": entity_id.to_string(),
                    "category": category.to_string(),
                    "content": content,
                    "metadata": metadata.unwrap_or(serde_json::json!({})),
                    "embedding": embedding,
                    "confidence": confidence,
                    "source": source,
                    "access_count": 0,
                    "created_at": now.to_rfc3339(),
                    "updated_at": now.to_rfc3339(),
                }),
            )
            .await?;
        }

        info!(
            "Stored long-term memory: {} for entity {}",
            category, entity_id
        );
        Ok(memory)
    }

    pub async fn get_long_term_memories(
        &self,
        entity_id: Uuid,
        category: Option<LongTermMemoryCategory>,
        limit: i32,
    ) -> Result<Vec<LongTermMemory>> {
        let agent_id = self
            .agent_id
            .ok_or_else(|| MemoryError::InvalidConfig("Agent ID not set".to_string()))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| MemoryError::Database("Database not available".to_string()))?;

        let mut conditions = serde_json::json!({
            "agent_id": agent_id.to_string(),
            "entity_id": entity_id.to_string(),
        });

        if let Some(cat) = category {
            conditions["category"] = serde_json::json!(cat.to_string());
        }

        let results = db
            .select(
                "long_term_memories",
                conditions,
                Some(vec![("confidence", "desc"), ("updated_at", "desc")]),
                Some(limit),
            )
            .await?;

        results
            .into_iter()
            .map(|row| serde_json::from_value(row).map_err(MemoryError::from))
            .collect()
    }

    pub async fn update_long_term_memory(
        &self,
        memory_id: Uuid,
        entity_id: Uuid,
        updates: serde_json::Value,
    ) -> Result<()> {
        let agent_id = self
            .agent_id
            .ok_or_else(|| MemoryError::InvalidConfig("Agent ID not set".to_string()))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| MemoryError::Database("Database not available".to_string()))?;

        let mut update_data = updates;
        update_data["updated_at"] = serde_json::json!(Utc::now().to_rfc3339());

        db.update(
            "long_term_memories",
            update_data,
            serde_json::json!({
                "id": memory_id.to_string(),
                "agent_id": agent_id.to_string(),
                "entity_id": entity_id.to_string(),
            }),
        )
        .await?;

        info!(
            "Updated long-term memory: {} for entity {}",
            memory_id, entity_id
        );
        Ok(())
    }

    pub async fn delete_long_term_memory(&self, memory_id: Uuid, entity_id: Uuid) -> Result<()> {
        let agent_id = self
            .agent_id
            .ok_or_else(|| MemoryError::InvalidConfig("Agent ID not set".to_string()))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| MemoryError::Database("Database not available".to_string()))?;

        db.delete(
            "long_term_memories",
            serde_json::json!({
                "id": memory_id.to_string(),
                "agent_id": agent_id.to_string(),
                "entity_id": entity_id.to_string(),
            }),
        )
        .await?;

        info!(
            "Deleted long-term memory: {} for entity {}",
            memory_id, entity_id
        );
        Ok(())
    }

    pub async fn get_current_session_summary(
        &self,
        room_id: Uuid,
    ) -> Result<Option<SessionSummary>> {
        let agent_id = self
            .agent_id
            .ok_or_else(|| MemoryError::InvalidConfig("Agent ID not set".to_string()))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| MemoryError::Database("Database not available".to_string()))?;

        let results = db
            .select(
                "session_summaries",
                serde_json::json!({
                    "agent_id": agent_id.to_string(),
                    "room_id": room_id.to_string(),
                }),
                Some(vec![("updated_at", "desc")]),
                Some(1),
            )
            .await?;

        if results.is_empty() {
            return Ok(None);
        }

        let summary: SessionSummary = serde_json::from_value(results[0].clone())?;
        Ok(Some(summary))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn store_session_summary(
        &self,
        agent_id: Uuid,
        room_id: Uuid,
        entity_id: Option<Uuid>,
        summary: String,
        message_count: i32,
        last_message_offset: i32,
        start_time: chrono::DateTime<Utc>,
        end_time: chrono::DateTime<Utc>,
        topics: Vec<String>,
        metadata: Option<serde_json::Value>,
        embedding: Option<Vec<f32>>,
    ) -> Result<SessionSummary> {
        let now = Utc::now();
        let id = Uuid::new_v4();

        let session_summary = SessionSummary {
            id,
            agent_id,
            room_id,
            entity_id,
            summary: summary.clone(),
            message_count,
            last_message_offset,
            start_time,
            end_time,
            topics: topics.clone(),
            metadata: metadata.clone().unwrap_or(serde_json::json!({})),
            embedding: embedding.clone(),
            created_at: now,
            updated_at: now,
        };

        if let Some(db) = &self.db {
            db.insert(
                "session_summaries",
                serde_json::json!({
                    "id": id.to_string(),
                    "agent_id": agent_id.to_string(),
                    "room_id": room_id.to_string(),
                    "entity_id": entity_id.map(|e| e.to_string()),
                    "summary": summary,
                    "message_count": message_count,
                    "last_message_offset": last_message_offset,
                    "start_time": start_time.to_rfc3339(),
                    "end_time": end_time.to_rfc3339(),
                    "topics": topics,
                    "metadata": metadata.unwrap_or(serde_json::json!({})),
                    "embedding": embedding,
                    "created_at": now.to_rfc3339(),
                    "updated_at": now.to_rfc3339(),
                }),
            )
            .await?;
        }

        info!("Stored session summary for room {}", room_id);
        Ok(session_summary)
    }

    pub async fn update_session_summary(
        &self,
        summary_id: Uuid,
        room_id: Uuid,
        updates: serde_json::Value,
    ) -> Result<()> {
        let agent_id = self
            .agent_id
            .ok_or_else(|| MemoryError::InvalidConfig("Agent ID not set".to_string()))?;

        let db = self
            .db
            .as_ref()
            .ok_or_else(|| MemoryError::Database("Database not available".to_string()))?;

        let mut update_data = updates;
        update_data["updated_at"] = serde_json::json!(Utc::now().to_rfc3339());

        db.update(
            "session_summaries",
            update_data,
            serde_json::json!({
                "id": summary_id.to_string(),
                "agent_id": agent_id.to_string(),
                "room_id": room_id.to_string(),
            }),
        )
        .await?;

        info!(
            "Updated session summary: {} for room {}",
            summary_id, room_id
        );
        Ok(())
    }

    pub async fn get_formatted_long_term_memories(&self, entity_id: Uuid) -> Result<String> {
        let memories = self.get_long_term_memories(entity_id, None, 20).await?;

        if memories.is_empty() {
            return Ok(String::new());
        }

        let mut grouped: HashMap<LongTermMemoryCategory, Vec<&LongTermMemory>> = HashMap::new();
        for memory in &memories {
            grouped.entry(memory.category).or_default().push(memory);
        }

        let mut sections = Vec::new();
        for (category, category_memories) in grouped {
            let category_name = match category {
                LongTermMemoryCategory::Episodic => "Episodic",
                LongTermMemoryCategory::Semantic => "Semantic",
                LongTermMemoryCategory::Procedural => "Procedural",
            };

            let items: Vec<String> = category_memories
                .iter()
                .map(|m| format!("- {}", m.content))
                .collect();

            sections.push(format!("**{}**:\n{}", category_name, items.join("\n")));
        }

        Ok(sections.join("\n\n"))
    }
}
