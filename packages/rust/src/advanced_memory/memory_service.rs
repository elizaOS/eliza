use crate::advanced_memory::types::{
    LongTermMemory, LongTermMemoryCategory, MemoryConfig, SessionSummary,
};
use crate::runtime::{AgentRuntime, Service};
use crate::types::database::GetMemoriesParams;
use crate::types::memory::{Memory, MemoryMetadata};
use crate::types::primitives::{Content, UUID};
use anyhow::Result;
use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, Weak};
use tracing::{debug, info};

pub struct MemoryService {
    runtime: Weak<AgentRuntime>,
    config: Mutex<MemoryConfig>,
    /// In-memory message counts per room (for threshold tracking)
    session_message_counts: Mutex<HashMap<UUID, i32>>,
    session_message_count_order: Mutex<VecDeque<UUID>>,
    /// In-memory extraction checkpoints: key = "entityId:roomId" -> message count
    last_extraction_checkpoints: Mutex<HashMap<String, i32>>,
    last_extraction_checkpoint_order: Mutex<VecDeque<String>>,
}

#[async_trait::async_trait]
impl Service for MemoryService {
    fn service_type(&self) -> &str {
        "memory"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> Result<()> {
        self.session_message_counts.lock().unwrap().clear();
        self.session_message_count_order.lock().unwrap().clear();
        self.last_extraction_checkpoints.lock().unwrap().clear();
        self.last_extraction_checkpoint_order
            .lock()
            .unwrap()
            .clear();
        Ok(())
    }
}

impl MemoryService {
    const MAX_LOCAL_SESSION_ENTRIES: usize = 500;

    pub fn new(runtime: Weak<AgentRuntime>, config: MemoryConfig) -> Self {
        Self {
            runtime,
            config: Mutex::new(config),
            session_message_counts: Mutex::new(HashMap::new()),
            session_message_count_order: Mutex::new(VecDeque::new()),
            last_extraction_checkpoints: Mutex::new(HashMap::new()),
            last_extraction_checkpoint_order: Mutex::new(VecDeque::new()),
        }
    }

    fn touch_lru_key<K>(order: &mut VecDeque<K>, key: &K)
    where
        K: Clone + PartialEq,
    {
        if let Some(index) = order.iter().position(|existing| existing == key) {
            order.remove(index);
        }
        order.push_back(key.clone());
    }

    fn prune_lru_map<K, V>(map: &mut HashMap<K, V>, order: &mut VecDeque<K>, max_entries: usize)
    where
        K: Clone + Eq + std::hash::Hash,
    {
        while map.len() > max_entries {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            map.remove(&oldest);
        }
    }

    // ── Config management ────────────────────────────────────────────

    pub fn get_config(&self) -> MemoryConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn update_config(&self, updates: MemoryConfig) {
        *self.config.lock().unwrap() = updates;
    }

    // ── Message count tracking ───────────────────────────────────────

    pub fn increment_message_count(&self, room_id: UUID) -> i32 {
        let mut counts = self.session_message_counts.lock().unwrap();
        let mut order = self.session_message_count_order.lock().unwrap();
        let new_count = {
            let count = counts.entry(room_id.clone()).or_insert(0);
            *count += 1;
            *count
        };
        Self::touch_lru_key(&mut order, &room_id);
        Self::prune_lru_map(&mut counts, &mut order, Self::MAX_LOCAL_SESSION_ENTRIES);
        new_count
    }

    pub fn reset_message_count(&self, room_id: UUID) {
        let mut counts = self.session_message_counts.lock().unwrap();
        let mut order = self.session_message_count_order.lock().unwrap();
        counts.insert(room_id.clone(), 0);
        Self::touch_lru_key(&mut order, &room_id);
        Self::prune_lru_map(&mut counts, &mut order, Self::MAX_LOCAL_SESSION_ENTRIES);
    }

    // ── Extraction checkpointing ─────────────────────────────────────

    fn extraction_key(entity_id: &UUID, room_id: &UUID) -> String {
        format!("{}:{}", entity_id, room_id)
    }

    pub fn get_last_extraction_checkpoint(&self, entity_id: &UUID, room_id: &UUID) -> i32 {
        let key = Self::extraction_key(entity_id, room_id);
        let checkpoints = self.last_extraction_checkpoints.lock().unwrap();
        let value = *checkpoints.get(&key).unwrap_or(&0);
        drop(checkpoints);

        if value != 0 {
            let mut order = self.last_extraction_checkpoint_order.lock().unwrap();
            Self::touch_lru_key(&mut order, &key);
        }

        value
    }

    pub fn set_last_extraction_checkpoint(
        &self,
        entity_id: &UUID,
        room_id: &UUID,
        message_count: i32,
    ) {
        let mut checkpoints = self.last_extraction_checkpoints.lock().unwrap();
        let mut order = self.last_extraction_checkpoint_order.lock().unwrap();
        let key = Self::extraction_key(entity_id, room_id);
        checkpoints.insert(key.clone(), message_count);
        Self::touch_lru_key(&mut order, &key);
        Self::prune_lru_map(
            &mut checkpoints,
            &mut order,
            Self::MAX_LOCAL_SESSION_ENTRIES,
        );
        debug!(
            "Set extraction checkpoint for {} in room {} at {}",
            entity_id, room_id, message_count
        );
    }

    /// Check if long-term extraction should run based on message count and interval.
    /// Mirrors the TS shouldRunExtraction logic exactly.
    pub fn should_run_extraction(
        &self,
        entity_id: &UUID,
        room_id: &UUID,
        current_message_count: i32,
    ) -> bool {
        let config = self.config.lock().unwrap();
        let threshold = config.long_term_extraction_threshold;
        let interval = config.long_term_extraction_interval;

        if current_message_count < threshold {
            return false;
        }

        let last_checkpoint = self.get_last_extraction_checkpoint(entity_id, room_id);
        let current_checkpoint = (current_message_count / interval) * interval;
        let should_run = current_message_count >= threshold && current_checkpoint > last_checkpoint;

        debug!(
            entity_id = %entity_id,
            room_id = %room_id,
            current_message_count,
            threshold,
            interval,
            last_checkpoint,
            current_checkpoint,
            should_run,
            "Extraction check"
        );

        should_run
    }

    // ── Long-term memory operations ──────────────────────────────────

    pub async fn store_long_term_memory(&self, memory: LongTermMemory) -> Result<UUID> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;

        let metadata = serde_json::to_value(&memory.metadata).unwrap_or(serde_json::Value::Null);
        let mut final_metadata = if let serde_json::Value::Object(map) = metadata {
            map
        } else {
            serde_json::Map::new()
        };

        final_metadata.insert(
            "category".to_string(),
            serde_json::to_value(&memory.category).unwrap(),
        );
        if let Some(conf) = memory.confidence {
            final_metadata.insert(
                "confidence".to_string(),
                serde_json::to_value(conf).unwrap(),
            );
        }
        if let Some(src) = &memory.source {
            final_metadata.insert("source".to_string(), serde_json::Value::String(src.clone()));
        }
        if let Some(acc) = memory.access_count {
            final_metadata.insert(
                "accessCount".to_string(),
                serde_json::to_value(acc).unwrap(),
            );
        }

        let mem = Memory {
            id: Some(memory.id),
            entity_id: memory.entity_id.clone(),
            agent_id: Some(memory.agent_id),
            content: Content {
                text: Some(memory.content),
                ..Default::default()
            },
            embedding: memory.embedding,
            room_id: UUID::default_uuid(),
            metadata: Some(MemoryMetadata::Custom(serde_json::Value::Object(
                final_metadata,
            ))),
            unique: Some(true),
            ..Default::default()
        };

        // Access database via generic adapter
        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;

        let id = db.create_memory(&mem, "long_term_memories").await?;

        info!(
            "Stored long-term memory: {:?} for entity {}",
            memory.category, memory.entity_id
        );

        Ok(id)
    }

    pub async fn get_long_term_memories(
        &self,
        entity_id: UUID,
        category: Option<LongTermMemoryCategory>,
        limit: i32,
    ) -> Result<Vec<LongTermMemory>> {
        if limit <= 0 {
            return Ok(vec![]);
        }

        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;

        // Do NOT pass count to DB — we need all memories to sort by
        // confidence first, then truncate (matches Python _top_k_by_confidence).
        let params = GetMemoriesParams {
            entity_id: Some(entity_id),
            agent_id: Some(runtime.agent_id.clone()),
            table_name: "long_term_memories".to_string(),
            ..Default::default()
        };

        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;

        let memories = db.get_memories(params).await?;

        let mut results = Vec::new();

        for mem in memories {
            let (category_val, confidence, source, access_count, extra_meta) =
                if let Some(MemoryMetadata::Custom(serde_json::Value::Object(mut map))) =
                    mem.metadata
                {
                    let cat = map
                        .remove("category")
                        .and_then(|v| serde_json::from_value(v).ok());
                    let conf = map
                        .remove("confidence")
                        .and_then(|v| v.as_f64())
                        .map(|f| f as f32);
                    let src = map
                        .remove("source")
                        .and_then(|v| v.as_str().map(|s| s.to_string()));
                    let acc = map
                        .remove("accessCount")
                        .and_then(|v| v.as_i64())
                        .map(|i| i as i32);
                    (cat, conf, src, acc, map)
                } else {
                    (None, None, None, None, serde_json::Map::new())
                };

            if let Some(req_cat) = &category {
                let req_str = serde_json::to_string(req_cat).unwrap();
                let actual_str = serde_json::to_string(&category_val).unwrap_or_default();
                if req_str != actual_str {
                    continue;
                }
            }

            let final_category = category_val.unwrap_or(LongTermMemoryCategory::Semantic);

            results.push(LongTermMemory {
                id: mem.id.unwrap_or_default(),
                agent_id: mem.agent_id.unwrap_or_default(),
                entity_id: mem.entity_id,
                category: final_category,
                content: mem.content.text.unwrap_or_default(),
                metadata: Some(extra_meta),
                embedding: mem.embedding,
                confidence,
                source,
                created_at: mem.created_at.unwrap_or(0),
                updated_at: 0,
                last_accessed_at: None,
                access_count,
                similarity: mem.similarity,
            });
        }

        // Sort by confidence (descending) then created_at (descending)
        results.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });

        // Truncate AFTER sorting (not at DB level) to ensure top-K by confidence
        results.truncate(limit as usize);

        Ok(results)
    }

    /// Get formatted long-term memories grouped by category.
    /// Matches the TS `getFormattedLongTermMemories` service method.
    pub async fn get_formatted_long_term_memories(&self, entity_id: UUID) -> Result<String> {
        let memories = self.get_long_term_memories(entity_id, None, 20).await?;

        if memories.is_empty() {
            return Ok(String::new());
        }

        // Group by category preserving insertion order
        let mut grouped: Vec<(String, Vec<&LongTermMemory>)> = Vec::new();
        for mem in &memories {
            let cat_str = format!("{:?}", mem.category);
            if let Some(entry) = grouped.iter_mut().find(|(k, _)| k == &cat_str) {
                entry.1.push(mem);
            } else {
                grouped.push((cat_str, vec![mem]));
            }
        }

        let mut sections: Vec<String> = Vec::new();
        for (category, items) in &grouped {
            let category_name = category
                .split('_')
                .map(|w| {
                    let mut c = w.chars();
                    match c.next() {
                        None => String::new(),
                        Some(first) => {
                            first.to_uppercase().to_string() + &c.as_str().to_lowercase()
                        }
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let item_lines = items
                .iter()
                .map(|m| format!("- {}", m.content))
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("**{}**:\n{}", category_name, item_lines));
        }

        Ok(sections.join("\n\n"))
    }

    // ── Session summary operations ───────────────────────────────────

    /// Get the most recent session summary for a room.
    /// Mirrors TS getCurrentSessionSummary.
    pub async fn get_current_session_summary(
        &self,
        room_id: UUID,
    ) -> Result<Option<SessionSummary>> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;

        let params = GetMemoriesParams {
            room_id: Some(room_id),
            agent_id: Some(runtime.agent_id.clone()),
            table_name: "session_summaries".to_string(),
            count: Some(1),
            ..Default::default()
        };

        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;

        let memories = db.get_memories(params).await?;

        if memories.is_empty() {
            return Ok(None);
        }

        let mem = &memories[0];
        Ok(Some(Self::memory_to_session_summary(mem)))
    }

    /// Store a new session summary.
    pub async fn store_session_summary(&self, summary: SessionSummary) -> Result<UUID> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;

        let mut meta = serde_json::Map::new();
        meta.insert(
            "summary".to_string(),
            serde_json::Value::String(summary.summary.clone()),
        );
        meta.insert(
            "messageCount".to_string(),
            serde_json::Value::Number(summary.message_count.into()),
        );
        meta.insert(
            "lastMessageOffset".to_string(),
            serde_json::Value::Number(summary.last_message_offset.into()),
        );
        meta.insert(
            "startTime".to_string(),
            serde_json::Value::Number(summary.start_time.into()),
        );
        meta.insert(
            "endTime".to_string(),
            serde_json::Value::Number(summary.end_time.into()),
        );
        if let Some(topics) = &summary.topics {
            meta.insert("topics".to_string(), serde_json::to_value(topics).unwrap());
        }
        if let Some(extra) = &summary.metadata {
            meta.insert(
                "extra".to_string(),
                serde_json::Value::Object(extra.clone()),
            );
        }

        let room_id_clone = summary.room_id.clone();
        let mem = Memory {
            id: Some(summary.id),
            entity_id: summary.entity_id.unwrap_or_else(UUID::default_uuid),
            agent_id: Some(summary.agent_id),
            room_id: summary.room_id,
            content: Content {
                text: Some(summary.summary),
                ..Default::default()
            },
            metadata: Some(MemoryMetadata::Custom(serde_json::Value::Object(meta))),
            unique: Some(true),
            ..Default::default()
        };

        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;

        let id = db.create_memory(&mem, "session_summaries").await?;
        info!("Stored session summary for room {}", room_id_clone);
        Ok(id)
    }

    /// Update an existing session summary by ID.
    /// We delete and re-create since the generic adapter doesn't have update.
    pub async fn update_session_summary(
        &self,
        id: UUID,
        room_id: UUID,
        updated: SessionSummary,
    ) -> Result<()> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;
        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;

        // Delete old
        db.delete_memory(&id).await?;

        // Re-create with updated fields
        self.store_session_summary(updated).await?;

        info!("Updated session summary {} for room {}", id, room_id);
        Ok(())
    }

    /// Convert a generic Memory row into a SessionSummary.
    fn memory_to_session_summary(mem: &Memory) -> SessionSummary {
        let mut summary_text = mem.content.text.clone().unwrap_or_default();
        let mut message_count = 0i32;
        let mut last_message_offset = 0i32;
        let mut start_time = 0i64;
        let mut end_time = 0i64;
        let mut topics: Option<Vec<String>> = None;
        let mut extra_meta: Option<serde_json::Map<String, serde_json::Value>> = None;

        if let Some(MemoryMetadata::Custom(serde_json::Value::Object(map))) = &mem.metadata {
            if let Some(serde_json::Value::String(s)) = map.get("summary") {
                summary_text = s.clone();
            }
            if let Some(v) = map.get("messageCount") {
                message_count = v.as_i64().unwrap_or(0) as i32;
            }
            if let Some(v) = map.get("lastMessageOffset") {
                last_message_offset = v.as_i64().unwrap_or(0) as i32;
            }
            if let Some(v) = map.get("startTime") {
                start_time = v.as_i64().unwrap_or(0);
            }
            if let Some(v) = map.get("endTime") {
                end_time = v.as_i64().unwrap_or(0);
            }
            if let Some(serde_json::Value::Array(arr)) = map.get("topics") {
                topics = Some(
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect(),
                );
            }
            if let Some(serde_json::Value::Object(m)) = map.get("extra") {
                extra_meta = Some(m.clone());
            }
        }

        SessionSummary {
            id: mem.id.clone().unwrap_or_default(),
            agent_id: mem.agent_id.clone().unwrap_or_default(),
            room_id: mem.room_id.clone(),
            entity_id: Some(mem.entity_id.clone()),
            summary: summary_text,
            message_count,
            last_message_offset,
            start_time,
            end_time,
            topics,
            metadata: extra_meta,
            embedding: mem.embedding.clone(),
            created_at: mem.created_at.unwrap_or(0),
            updated_at: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_message_count_cache_is_bounded() {
        let service = MemoryService::new(Weak::new(), MemoryConfig::default());

        for index in 0..600 {
            service.increment_message_count(UUID::new_v4());
            if index % 3 == 0 {
                service.reset_message_count(UUID::new_v4());
            }
        }

        assert_eq!(
            service.session_message_counts.lock().unwrap().len(),
            MemoryService::MAX_LOCAL_SESSION_ENTRIES
        );
        assert_eq!(
            service.session_message_count_order.lock().unwrap().len(),
            MemoryService::MAX_LOCAL_SESSION_ENTRIES
        );
    }

    #[test]
    fn extraction_checkpoint_cache_is_bounded() {
        let service = MemoryService::new(Weak::new(), MemoryConfig::default());

        for index in 0..600 {
            let entity_id = UUID::new_v4();
            let room_id = UUID::new_v4();
            service.set_last_extraction_checkpoint(&entity_id, &room_id, index);
            let _ = service.get_last_extraction_checkpoint(&entity_id, &room_id);
        }

        assert_eq!(
            service.last_extraction_checkpoints.lock().unwrap().len(),
            MemoryService::MAX_LOCAL_SESSION_ENTRIES
        );
        assert_eq!(
            service
                .last_extraction_checkpoint_order
                .lock()
                .unwrap()
                .len(),
            MemoryService::MAX_LOCAL_SESSION_ENTRIES
        );
    }
}
