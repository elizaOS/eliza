//! Built-in advanced memory (gated by `Character.advancedMemory`).
//!
//! Rust parity goals (w/ TS core advanced memory):
//! - `MemoryService` ("memory") with config + extraction checkpointing
//! - Providers: `LONG_TERM_MEMORY`, `SUMMARIZED_CONTEXT`
//! - Evaluators: `MEMORY_SUMMARIZATION`, `LONG_TERM_MEMORY_EXTRACTION`

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;

use anyhow::Result;
use serde_json::Value;

use crate::runtime::{AgentRuntime, Service};
use crate::types::components::{
    ActionResult, EvaluatorDefinition, EvaluatorHandler, HandlerOptions, ProviderDefinition,
    ProviderHandler, ProviderResult,
};
use crate::types::database::GetMemoriesParams;
use crate::types::plugin::Plugin;
use crate::types::primitives::string_to_uuid;
use crate::types::primitives::UUID;
use crate::types::settings::SettingValue;
use crate::types::state::State;
use crate::types::Memory;

// Import templates from centralized prompts
use crate::prompts::{
    INITIAL_SUMMARIZATION_TEMPLATE, LONG_TERM_EXTRACTION_TEMPLATE, UPDATE_SUMMARIZATION_TEMPLATE,
};

const TABLE_SESSION_SUMMARY: &str = "session_summary";
const TABLE_LONG_TERM_MEMORY: &str = "long_term_memory";
const TABLE_EXTRACTION_CHECKPOINT: &str = "memory_extraction_checkpoint";

/// Configuration for advanced memory behavior.
#[derive(Clone, Debug)]
pub struct MemoryConfig {
    /// Message count before first summary.
    pub short_term_summarization_threshold: i32,
    /// Number of recent messages to retain after summarization (best-effort).
    pub short_term_retain_recent: i32,
    /// Messages between summary updates.
    pub short_term_summarization_interval: i32,
    /// Whether long-term extraction is enabled.
    pub long_term_extraction_enabled: bool,
    /// Minimum confidence for storing extracted memories.
    pub long_term_confidence_threshold: f64,
    /// Message count before first long-term extraction.
    pub long_term_extraction_threshold: i32,
    /// Extraction interval (messages).
    pub long_term_extraction_interval: i32,
    /// Max tokens for summarization model call.
    pub summary_max_tokens: i32,
    /// Cap on number of new messages to include per summary update.
    pub summary_max_new_messages: i32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            short_term_summarization_threshold: 16,
            short_term_retain_recent: 6,
            short_term_summarization_interval: 10,
            long_term_extraction_enabled: true,
            long_term_confidence_threshold: 0.85,
            long_term_extraction_threshold: 30,
            long_term_extraction_interval: 10,
            summary_max_tokens: 2500,
            summary_max_new_messages: 20,
        }
    }
}

/// Long-term memory category (cognitive-science inspired).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LongTermMemoryCategory {
    /// Specific past events.
    Episodic,
    /// Persistent facts and identity.
    Semantic,
    /// Repeated workflows and skills.
    Procedural,
}

impl LongTermMemoryCategory {
    fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "episodic" => Some(Self::Episodic),
            "semantic" => Some(Self::Semantic),
            "procedural" => Some(Self::Procedural),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Episodic => "episodic",
            Self::Semantic => "semantic",
            Self::Procedural => "procedural",
        }
    }
}

/// A stored long-term memory fact.
#[derive(Clone, Debug)]
pub struct LongTermMemory {
    /// Memory id.
    pub id: UUID,
    /// Agent id.
    pub agent_id: UUID,
    /// Entity (user) id.
    pub entity_id: UUID,
    /// Category.
    pub category: LongTermMemoryCategory,
    /// Extracted content.
    pub content: String,
    /// Confidence score (0.0-1.0).
    pub confidence: f64,
    /// Source label.
    pub source: Option<String>,
    /// Arbitrary metadata.
    pub metadata: Value,
}

/// A rolling session summary for a room.
#[derive(Clone, Debug)]
pub struct SessionSummary {
    /// Summary id.
    pub id: UUID,
    /// Agent id.
    pub agent_id: UUID,
    /// Room id.
    pub room_id: UUID,
    /// Optional entity id.
    pub entity_id: Option<UUID>,
    /// Summary text.
    pub summary: String,
    /// Total messages summarized.
    pub message_count: i32,
    /// Offset for incremental updates.
    pub last_message_offset: i32,
    /// Topic labels.
    pub topics: Vec<String>,
    /// Arbitrary metadata.
    pub metadata: Value,
}

#[derive(Clone, Debug)]
struct SummaryResult {
    summary: String,
    topics: Vec<String>,
    key_points: Vec<String>,
}

fn extract_between(haystack: &str, start_tag: &str, end_tag: &str) -> Option<String> {
    let start = haystack.find(start_tag)? + start_tag.len();
    let rest = &haystack[start..];
    let end = rest.find(end_tag)?;
    Some(rest[..end].trim().to_string())
}

fn parse_summary_xml(xml: &str) -> SummaryResult {
    let text = extract_between(xml, "<text>", "</text>")
        .unwrap_or_else(|| "Summary not available".to_string());
    let topics_raw = extract_between(xml, "<topics>", "</topics>").unwrap_or_default();
    let topics = topics_raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    let mut key_points: Vec<String> = Vec::new();
    let mut rem = xml;
    while let Some(start) = rem.find("<point>") {
        let after = &rem[start + "<point>".len()..];
        let Some(end) = after.find("</point>") else {
            break;
        };
        key_points.push(after[..end].trim().to_string());
        rem = &after[end + "</point>".len()..];
    }

    SummaryResult {
        summary: text,
        topics,
        key_points,
    }
}

#[derive(Clone, Debug)]
struct MemoryExtraction {
    category: LongTermMemoryCategory,
    content: String,
    confidence: f64,
}

fn parse_memory_extraction_xml(xml: &str) -> Vec<MemoryExtraction> {
    let mut out: Vec<MemoryExtraction> = Vec::new();
    let mut rem = xml;
    while let Some(mem_start) = rem.find("<memory>") {
        let after = &rem[mem_start + "<memory>".len()..];
        let Some(mem_end) = after.find("</memory>") else {
            break;
        };
        let block = &after[..mem_end];

        let cat = extract_between(block, "<category>", "</category>");
        let content = extract_between(block, "<content>", "</content>");
        let conf = extract_between(block, "<confidence>", "</confidence>")
            .and_then(|s| s.parse::<f64>().ok());

        if let (Some(cat), Some(content), Some(conf)) = (cat, content, conf) {
            if let Some(category) = LongTermMemoryCategory::from_str(&cat) {
                out.push(MemoryExtraction {
                    category,
                    content,
                    confidence: conf,
                });
            }
        }

        rem = &after[mem_end + "</memory>".len()..];
    }
    out
}

/// Built-in memory service registered as `"memory"`.
#[derive(Default)]
pub struct MemoryService {
    config: Mutex<MemoryConfig>,
    session_summaries: Mutex<HashMap<UUID, SessionSummary>>,
    long_term: Mutex<HashMap<UUID, Vec<LongTermMemory>>>,
    checkpoints: Mutex<HashMap<String, i32>>,
}

impl MemoryService {
    /// Get a copy of the current config.
    pub fn get_config(&self) -> MemoryConfig {
        self.config.lock().expect("lock poisoned").clone()
    }

    /// Configure from runtime settings (best-effort).
    pub async fn configure_from_runtime(&self, runtime: &AgentRuntime) {
        async fn get_i(rt: &AgentRuntime, key: &str) -> Option<i32> {
            match rt.get_setting(key).await {
                Some(SettingValue::Number(n)) => Some(n as i32),
                Some(SettingValue::String(s)) => s.trim().parse::<i32>().ok(),
                _ => None,
            }
        }
        async fn get_f(rt: &AgentRuntime, key: &str) -> Option<f64> {
            match rt.get_setting(key).await {
                Some(SettingValue::Number(n)) => Some(n),
                Some(SettingValue::String(s)) => s.trim().parse::<f64>().ok(),
                _ => None,
            }
        }
        async fn get_b(rt: &AgentRuntime, key: &str) -> Option<bool> {
            match rt.get_setting(key).await {
                Some(SettingValue::Bool(b)) => Some(b),
                Some(SettingValue::String(s)) => Some(s.trim().eq_ignore_ascii_case("true")),
                _ => None,
            }
        }

        // Collect all settings first (before acquiring lock) to avoid holding lock across await
        let summarization_threshold = get_i(runtime, "MEMORY_SUMMARIZATION_THRESHOLD").await;
        let retain_recent = get_i(runtime, "MEMORY_RETAIN_RECENT").await;
        let summarization_interval = get_i(runtime, "MEMORY_SUMMARIZATION_INTERVAL").await;
        let max_new_messages = get_i(runtime, "MEMORY_MAX_NEW_MESSAGES").await;
        let long_term_enabled = get_b(runtime, "MEMORY_LONG_TERM_ENABLED").await;
        let confidence_threshold = get_f(runtime, "MEMORY_CONFIDENCE_THRESHOLD").await;
        let extraction_threshold = get_i(runtime, "MEMORY_EXTRACTION_THRESHOLD").await;
        let extraction_interval = get_i(runtime, "MEMORY_EXTRACTION_INTERVAL").await;

        // Now acquire lock and apply settings
        let mut cfg = self.config.lock().expect("lock poisoned");
        if let Some(v) = summarization_threshold {
            cfg.short_term_summarization_threshold = v;
        }
        if let Some(v) = retain_recent {
            cfg.short_term_retain_recent = v;
        }
        if let Some(v) = summarization_interval {
            cfg.short_term_summarization_interval = v;
        }
        if let Some(v) = max_new_messages {
            cfg.summary_max_new_messages = v;
        }
        if let Some(v) = long_term_enabled {
            cfg.long_term_extraction_enabled = v;
        }
        if let Some(v) = confidence_threshold {
            cfg.long_term_confidence_threshold = v;
        }
        if let Some(v) = extraction_threshold {
            cfg.long_term_extraction_threshold = v;
        }
        if let Some(v) = extraction_interval {
            cfg.long_term_extraction_interval = v;
        }
    }

    fn checkpoint_key(entity_id: UUID, room_id: UUID) -> String {
        format!("memory:extraction:{}:{}", entity_id, room_id)
    }

    fn long_term_room_id(entity_id: &UUID) -> UUID {
        string_to_uuid(format!("advanced-memory:long-term:{}", entity_id))
    }

    fn checkpoint_room_id(entity_id: &UUID, room_id: &UUID) -> UUID {
        string_to_uuid(format!(
            "advanced-memory:checkpoint:{}:{}",
            entity_id, room_id
        ))
    }

    /// Get the current session summary for a room.
    pub fn get_current_session_summary(&self, room_id: UUID) -> Option<SessionSummary> {
        self.session_summaries
            .lock()
            .expect("lock poisoned")
            .get(&room_id)
            .cloned()
    }

    /// Store/replace the session summary for a room.
    pub fn store_session_summary(&self, summary: SessionSummary) {
        let room_id = summary.room_id.clone();
        self.session_summaries
            .lock()
            .expect("lock poisoned")
            .insert(room_id, summary);
    }

    /// Get stored long-term memories for an entity.
    pub fn get_long_term_memories(&self, entity_id: UUID, limit: usize) -> Vec<LongTermMemory> {
        let mut out = self
            .long_term
            .lock()
            .expect("lock poisoned")
            .get(&entity_id)
            .cloned()
            .unwrap_or_default();
        if limit == 0 || out.is_empty() {
            return Vec::new();
        }
        if out.len() > limit {
            out.select_nth_unstable_by(limit, |a, b| {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            out.truncate(limit);
        }
        out.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.truncate(limit);
        out
    }

    /// Store a long-term memory.
    pub fn store_long_term_memory(&self, memory: LongTermMemory) {
        let entity_id = memory.entity_id.clone();
        self.long_term
            .lock()
            .expect("lock poisoned")
            .entry(entity_id)
            .or_default()
            .push(memory);
    }

    /// Get the last extraction checkpoint (message count) for an entity+room.
    pub fn get_last_extraction_checkpoint(&self, entity_id: UUID, room_id: UUID) -> i32 {
        let key = Self::checkpoint_key(entity_id, room_id);
        *self
            .checkpoints
            .lock()
            .expect("lock poisoned")
            .get(&key)
            .unwrap_or(&0)
    }

    /// Set the last extraction checkpoint (message count) for an entity+room.
    pub fn set_last_extraction_checkpoint(
        &self,
        entity_id: UUID,
        room_id: UUID,
        message_count: i32,
    ) {
        let key = Self::checkpoint_key(entity_id, room_id);
        self.checkpoints
            .lock()
            .expect("lock poisoned")
            .insert(key, message_count);
    }

    /// Decide whether we should run long-term extraction for an entity+room.
    pub fn should_run_extraction(
        &self,
        entity_id: UUID,
        room_id: UUID,
        current_message_count: i32,
    ) -> bool {
        let cfg = self.get_config();
        if current_message_count < cfg.long_term_extraction_threshold {
            return false;
        }
        let last = self.get_last_extraction_checkpoint(entity_id, room_id);
        let interval = cfg.long_term_extraction_interval.max(1);
        let current_checkpoint = (current_message_count / interval) * interval;
        current_checkpoint > last
    }

    /// Format long-term memories into markdown sections.
    pub fn formatted_long_term_memories(&self, entity_id: UUID) -> String {
        let mems = self.get_long_term_memories(entity_id, 20);
        if mems.is_empty() {
            return String::new();
        }

        let mut grouped: HashMap<LongTermMemoryCategory, Vec<LongTermMemory>> = HashMap::new();
        for m in mems {
            grouped.entry(m.category).or_default().push(m);
        }

        let mut sections: Vec<String> = Vec::new();
        for (cat, items) in grouped {
            let header = cat
                .as_str()
                .split('_')
                .map(|w| {
                    let mut c = w.chars();
                    match c.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let lines = items
                .into_iter()
                .map(|m| format!("- {}", m.content))
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("**{}**:\n{}", header, lines));
        }

        sections.join("\n\n")
    }

    async fn get_last_extraction_checkpoint_db(
        &self,
        runtime: &AgentRuntime,
        entity_id: &UUID,
        room_id: &UUID,
    ) -> i32 {
        let Some(adapter) = runtime.get_adapter() else {
            return self.get_last_extraction_checkpoint(entity_id.clone(), room_id.clone());
        };
        let cp_room = Self::checkpoint_room_id(entity_id, room_id);
        let rows = adapter
            .get_memories(GetMemoriesParams {
                table_name: TABLE_EXTRACTION_CHECKPOINT.to_string(),
                room_id: Some(cp_room),
                agent_id: Some(runtime.agent_id.clone()),
                count: Some(1),
                ..Default::default()
            })
            .await
            .unwrap_or_default();
        let Some(first) = rows.first() else {
            return 0;
        };
        let s = first.content.text.clone().unwrap_or_default();
        s.trim().parse::<i32>().unwrap_or(0)
    }

    async fn set_last_extraction_checkpoint_db(
        &self,
        runtime: &AgentRuntime,
        entity_id: &UUID,
        room_id: &UUID,
        message_count: i32,
    ) {
        let Some(adapter) = runtime.get_adapter() else {
            self.set_last_extraction_checkpoint(entity_id.clone(), room_id.clone(), message_count);
            return;
        };
        let cp_room = Self::checkpoint_room_id(entity_id, room_id);
        let mem = Memory {
            id: Some(UUID::new_v4()),
            entity_id: runtime.agent_id.clone(),
            agent_id: Some(runtime.agent_id.clone()),
            created_at: Some(chrono_timestamp()),
            content: crate::types::primitives::Content {
                text: Some(message_count.to_string()),
                ..Default::default()
            },
            embedding: None,
            room_id: cp_room,
            world_id: None,
            unique: Some(false),
            similarity: None,
            metadata: Some(crate::types::memory::MemoryMetadata::Custom(
                serde_json::json!({
                    "type": TABLE_EXTRACTION_CHECKPOINT,
                    "entityId": entity_id.as_str(),
                    "roomId": room_id.as_str(),
                }),
            )),
        };
        let _ = adapter
            .create_memory(&mem, TABLE_EXTRACTION_CHECKPOINT)
            .await;
    }

    async fn should_run_extraction_db(
        &self,
        runtime: &AgentRuntime,
        entity_id: &UUID,
        room_id: &UUID,
        current_message_count: i32,
    ) -> bool {
        let cfg = self.get_config();
        if current_message_count < cfg.long_term_extraction_threshold {
            return false;
        }
        let last = self
            .get_last_extraction_checkpoint_db(runtime, entity_id, room_id)
            .await;
        let interval = cfg.long_term_extraction_interval.max(1);
        let current_checkpoint = (current_message_count / interval) * interval;
        current_checkpoint > last
    }

    async fn get_long_term_memories_db(
        &self,
        runtime: &AgentRuntime,
        entity_id: &UUID,
        limit: usize,
    ) -> Vec<LongTermMemory> {
        let Some(adapter) = runtime.get_adapter() else {
            return self.get_long_term_memories(entity_id.clone(), limit);
        };
        let room_id = Self::long_term_room_id(entity_id);
        let rows = adapter
            .get_memories(GetMemoriesParams {
                table_name: TABLE_LONG_TERM_MEMORY.to_string(),
                room_id: Some(room_id),
                agent_id: Some(runtime.agent_id.clone()),
                count: Some(limit as i32),
                ..Default::default()
            })
            .await
            .unwrap_or_default();

        let mut out: Vec<LongTermMemory> = Vec::new();
        for m in rows {
            let meta = match m.metadata {
                Some(crate::types::memory::MemoryMetadata::Custom(v)) => v,
                None => Value::Null,
            };
            let cat = meta
                .get("category")
                .and_then(|v| v.as_str())
                .and_then(LongTermMemoryCategory::from_str)
                .unwrap_or(LongTermMemoryCategory::Semantic);
            let conf = meta
                .get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            let source = meta
                .get("source")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            out.push(LongTermMemory {
                id: m.id.unwrap_or_else(UUID::new_v4),
                agent_id: runtime.agent_id.clone(),
                entity_id: entity_id.clone(),
                category: cat,
                content: m.content.text.unwrap_or_default(),
                confidence: conf,
                source,
                metadata: meta
                    .get("metadata")
                    .cloned()
                    .unwrap_or(Value::Object(Default::default())),
            });
        }
        out.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    async fn store_long_term_memory_db(&self, runtime: &AgentRuntime, memory: &LongTermMemory) {
        let Some(adapter) = runtime.get_adapter() else {
            self.store_long_term_memory(memory.clone());
            return;
        };
        let room_id = Self::long_term_room_id(&memory.entity_id);
        let mem = Memory {
            id: Some(memory.id.clone()),
            entity_id: memory.entity_id.clone(),
            agent_id: Some(runtime.agent_id.clone()),
            created_at: Some(chrono_timestamp()),
            content: crate::types::primitives::Content {
                text: Some(memory.content.clone()),
                ..Default::default()
            },
            embedding: None,
            room_id,
            world_id: None,
            unique: Some(false),
            similarity: None,
            metadata: Some(crate::types::memory::MemoryMetadata::Custom(
                serde_json::json!({
                    "type": TABLE_LONG_TERM_MEMORY,
                    "category": memory.category.as_str(),
                    "confidence": memory.confidence,
                    "source": memory.source,
                    "metadata": memory.metadata,
                }),
            )),
        };
        let _ = adapter.create_memory(&mem, TABLE_LONG_TERM_MEMORY).await;
        self.store_long_term_memory(memory.clone());
    }

    async fn get_session_summary_db(
        &self,
        runtime: &AgentRuntime,
        room_id: &UUID,
    ) -> Option<SessionSummary> {
        let Some(adapter) = runtime.get_adapter() else {
            return self.get_current_session_summary(room_id.clone());
        };
        let rows = adapter
            .get_memories(GetMemoriesParams {
                table_name: TABLE_SESSION_SUMMARY.to_string(),
                room_id: Some(room_id.clone()),
                agent_id: Some(runtime.agent_id.clone()),
                count: Some(1),
                ..Default::default()
            })
            .await
            .unwrap_or_default();
        let m = rows.first()?;
        let meta = match &m.metadata {
            Some(crate::types::memory::MemoryMetadata::Custom(v)) => v.clone(),
            None => Value::Null,
        };
        Some(SessionSummary {
            id: m.id.clone().unwrap_or_else(UUID::new_v4),
            agent_id: runtime.agent_id.clone(),
            room_id: room_id.clone(),
            entity_id: None,
            summary: m.content.text.clone().unwrap_or_default(),
            message_count: meta
                .get("messageCount")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as i32,
            last_message_offset: meta
                .get("lastMessageOffset")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as i32,
            topics: meta
                .get("topics")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            metadata: meta
                .get("metadata")
                .cloned()
                .unwrap_or(Value::Object(Default::default())),
        })
    }

    async fn store_session_summary_db(&self, runtime: &AgentRuntime, summary: &SessionSummary) {
        let Some(adapter) = runtime.get_adapter() else {
            self.store_session_summary(summary.clone());
            return;
        };
        let mem = Memory {
            id: Some(summary.id.clone()),
            entity_id: runtime.agent_id.clone(),
            agent_id: Some(runtime.agent_id.clone()),
            created_at: Some(chrono_timestamp()),
            content: crate::types::primitives::Content {
                text: Some(summary.summary.clone()),
                ..Default::default()
            },
            embedding: None,
            room_id: summary.room_id.clone(),
            world_id: None,
            unique: Some(false),
            similarity: None,
            metadata: Some(crate::types::memory::MemoryMetadata::Custom(
                serde_json::json!({
                    "type": TABLE_SESSION_SUMMARY,
                    "messageCount": summary.message_count,
                    "lastMessageOffset": summary.last_message_offset,
                    "topics": summary.topics,
                    "metadata": summary.metadata,
                }),
            )),
        };
        let _ = adapter.create_memory(&mem, TABLE_SESSION_SUMMARY).await;
        self.store_session_summary(summary.clone());
    }

    fn format_long_term_memories(mems: Vec<LongTermMemory>) -> String {
        if mems.is_empty() {
            return String::new();
        }
        let mut grouped: HashMap<LongTermMemoryCategory, Vec<LongTermMemory>> = HashMap::new();
        for m in mems {
            grouped.entry(m.category).or_default().push(m);
        }
        let mut sections: Vec<String> = Vec::new();
        for (cat, items) in grouped {
            let header = cat
                .as_str()
                .split('_')
                .map(|w| {
                    let mut c = w.chars();
                    match c.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let lines = items
                .into_iter()
                .map(|m| format!("- {}", m.content))
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("**{}**:\n{}", header, lines));
        }
        sections.join("\n\n")
    }
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
        self.session_summaries
            .lock()
            .expect("lock poisoned")
            .clear();
        self.long_term.lock().expect("lock poisoned").clear();
        self.checkpoints.lock().expect("lock poisoned").clear();
        Ok(())
    }
}

struct LongTermMemoryProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for LongTermMemoryProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "LONG_TERM_MEMORY".to_string(),
            description: Some("Persistent facts and preferences about the user".to_string()),
            dynamic: Some(false),
            position: Some(50),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult, anyhow::Error> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(svc) = runtime.get_service("memory").await else {
            return Ok(ProviderResult::default());
        };
        let Some(ms) = svc.as_any().downcast_ref::<MemoryService>() else {
            return Ok(ProviderResult::default());
        };

        if message.entity_id == runtime.agent_id {
            return Ok(ProviderResult::default());
        }

        let mems = ms
            .get_long_term_memories_db(&runtime, &message.entity_id, 20)
            .await;
        let formatted = MemoryService::format_long_term_memories(mems);
        if formatted.is_empty() {
            return Ok(ProviderResult::default());
        }

        let text = format!("# What I Know About You\n\n{}", formatted);
        Ok(ProviderResult {
            text: Some(text.clone()),
            values: Some(HashMap::from([(
                "longTermMemories".to_string(),
                Value::String(text),
            )])),
            data: Some(HashMap::from([(
                "memoryCount".to_string(),
                Value::Number((1_i64).into()),
            )])),
        })
    }
}

struct ContextSummaryProvider {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl ProviderHandler for ContextSummaryProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "SUMMARIZED_CONTEXT".to_string(),
            description: Some(
                "Provides summarized context from previous conversations".to_string(),
            ),
            dynamic: Some(false),
            position: Some(96),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult, anyhow::Error> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(svc) = runtime.get_service("memory").await else {
            return Ok(ProviderResult::default());
        };
        let Some(ms) = svc.as_any().downcast_ref::<MemoryService>() else {
            return Ok(ProviderResult::default());
        };

        let Some(summary) = ms.get_session_summary_db(&runtime, &message.room_id).await else {
            return Ok(ProviderResult::default());
        };

        let mut summary_with_topics = format!(
            "**Previous Conversation** ({} messages)\n{}",
            summary.message_count, summary.summary
        );
        if !summary.topics.is_empty() {
            summary_with_topics.push_str(&format!("\n*Topics: {}*", summary.topics.join(", ")));
        }

        let text = format!("# Conversation Summary\n\n{}", summary_with_topics);
        Ok(ProviderResult {
            text: Some(text.clone()),
            values: Some(HashMap::from([(
                "sessionSummariesWithTopics".to_string(),
                Value::String(text),
            )])),
            data: Some(HashMap::from([(
                "messageCount".to_string(),
                Value::Number((summary.message_count as i64).into()),
            )])),
        })
    }
}

struct SummarizationEvaluator {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl EvaluatorHandler for SummarizationEvaluator {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "MEMORY_SUMMARIZATION".to_string(),
            description: "Automatically summarizes conversations to optimize context usage"
                .to_string(),
            always_run: Some(true),
            similes: Some(vec![
                "CONVERSATION_SUMMARY".to_string(),
                "CONTEXT_COMPRESSION".to_string(),
                "MEMORY_OPTIMIZATION".to_string(),
            ]),
            examples: Vec::new(),
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        if message.content.text.is_none() {
            return false;
        }
        let Some(runtime) = self.runtime.upgrade() else {
            return false;
        };
        let Some(svc) = runtime.get_service("memory").await else {
            return false;
        };
        let Some(ms) = svc.as_any().downcast_ref::<MemoryService>() else {
            return false;
        };

        let room_id = message.room_id.clone();
        let cfg = ms.get_config();
        let current_count = count_room_messages(&runtime, room_id.clone()).await;
        let existing = ms.get_session_summary_db(&runtime, &room_id).await;

        if let Some(existing) = existing {
            (current_count - existing.last_message_offset) >= cfg.short_term_summarization_interval
        } else {
            current_count >= cfg.short_term_summarization_threshold
        }
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(svc) = runtime.get_service("memory").await else {
            return Ok(None);
        };
        let Some(ms) = svc.as_any().downcast_ref::<MemoryService>() else {
            return Ok(None);
        };

        let room_id = message.room_id.clone();
        let messages = get_room_messages(&runtime, room_id.clone(), 1000).await;
        if messages.is_empty() {
            return Ok(None);
        }

        let existing = ms.get_session_summary_db(&runtime, &room_id).await;
        let existing_offset = existing
            .as_ref()
            .map(|s| s.last_message_offset)
            .unwrap_or(0);
        let cfg = ms.get_config();

        let mut dialogue_lines: Vec<String> = Vec::new();
        for m in messages.iter() {
            if let Some(t) = &m.content.text {
                let sender = if m.entity_id == runtime.agent_id {
                    runtime.character.read().await.name.clone()
                } else {
                    "User".to_string()
                };
                dialogue_lines.push(format!("{}: {}", sender, t));
            }
        }

        if dialogue_lines.is_empty() {
            return Ok(None);
        }

        let max_new = cfg.summary_max_new_messages.max(1) as usize;
        let new_slice = dialogue_lines
            .iter()
            .skip(existing_offset as usize)
            .take(max_new)
            .cloned()
            .collect::<Vec<_>>();
        if new_slice.is_empty() {
            return Ok(None);
        }

        let prompt = if let Some(s) = &existing {
            UPDATE_SUMMARIZATION_TEMPLATE
                .replace("{{existingSummary}}", &s.summary)
                .replace("{{existingTopics}}", &s.topics.join(", "))
                .replace("{{newMessages}}", &new_slice.join("\n"))
        } else {
            INITIAL_SUMMARIZATION_TEMPLATE.replace("{{recentMessages}}", &new_slice.join("\n"))
        };

        let raw = runtime
            .use_model(
                "TEXT_LARGE",
                serde_json::json!({ "prompt": prompt, "maxTokens": cfg.summary_max_tokens }),
            )
            .await?;
        let parsed = parse_summary_xml(&raw);

        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let next = if let Some(mut s) = existing {
            s.summary = parsed.summary;
            s.topics = parsed.topics;
            s.message_count = count_room_messages(&runtime, room_id.clone()).await;
            s.last_message_offset = s.message_count;
            s.metadata = serde_json::json!({ "keyPoints": parsed.key_points, "updatedAt": now_ms });
            s
        } else {
            let total = count_room_messages(&runtime, room_id.clone()).await;
            SessionSummary {
                id: UUID::new_v4(),
                agent_id: runtime.agent_id.clone(),
                room_id: room_id.clone(),
                entity_id: if message.entity_id == runtime.agent_id {
                    None
                } else {
                    Some(message.entity_id.clone())
                },
                summary: parsed.summary,
                message_count: total,
                last_message_offset: total,
                topics: parsed.topics,
                metadata: serde_json::json!({ "keyPoints": parsed.key_points, "createdAt": now_ms }),
            }
        };
        ms.store_session_summary_db(&runtime, &next).await;

        Ok(None)
    }
}

struct LongTermExtractionEvaluator {
    runtime: Weak<AgentRuntime>,
}

#[async_trait::async_trait]
impl EvaluatorHandler for LongTermExtractionEvaluator {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "LONG_TERM_MEMORY_EXTRACTION".to_string(),
            description: "Extracts long-term facts about users from conversations".to_string(),
            always_run: Some(true),
            similes: Some(vec![
                "MEMORY_EXTRACTION".to_string(),
                "FACT_LEARNING".to_string(),
                "USER_PROFILING".to_string(),
            ]),
            examples: Vec::new(),
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let Some(runtime) = self.runtime.upgrade() else {
            return false;
        };
        if message.entity_id == runtime.agent_id {
            return false;
        }
        if message.content.text.is_none() {
            return false;
        }
        let Some(svc) = runtime.get_service("memory").await else {
            return false;
        };
        let Some(ms) = svc.as_any().downcast_ref::<MemoryService>() else {
            return false;
        };

        let cfg = ms.get_config();
        if !cfg.long_term_extraction_enabled {
            return false;
        }

        let room_id = message.room_id.clone();
        let entity_id = message.entity_id.clone();
        let current_message_count = count_room_messages(&runtime, room_id.clone()).await;
        ms.should_run_extraction_db(&runtime, &entity_id, &room_id, current_message_count)
            .await
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(svc) = runtime.get_service("memory").await else {
            return Ok(None);
        };
        let Some(ms) = svc.as_any().downcast_ref::<MemoryService>() else {
            return Ok(None);
        };

        let room_id = message.room_id.clone();
        let entity_id = message.entity_id.clone();
        let recent = get_room_messages(&runtime, room_id.clone(), 50).await;
        let mut lines: Vec<String> = Vec::new();
        for m in &recent {
            if let Some(t) = &m.content.text {
                let sender = if m.entity_id == runtime.agent_id {
                    runtime.character.read().await.name.clone()
                } else {
                    "User".to_string()
                };
                lines.push(format!("{}: {}", sender, t));
            }
        }

        let existing = ms.get_long_term_memories_db(&runtime, &entity_id, 30).await;
        let existing_text = if existing.is_empty() {
            "None yet".to_string()
        } else {
            existing
                .iter()
                .map(|m| {
                    format!(
                        "[{}] {} (confidence: {})",
                        m.category.as_str(),
                        m.content,
                        m.confidence
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        let prompt = LONG_TERM_EXTRACTION_TEMPLATE
            .replace("{{recentMessages}}", &lines.join("\n"))
            .replace("{{existingMemories}}", &existing_text);

        let raw = runtime
            .use_model("TEXT_LARGE", serde_json::json!({ "prompt": prompt }))
            .await?;
        let extracted = parse_memory_extraction_xml(&raw);

        let cfg = ms.get_config();
        for ex in extracted {
            if ex.confidence >= cfg.long_term_confidence_threshold.max(0.85) {
                let memory = LongTermMemory {
                    id: UUID::new_v4(),
                    agent_id: runtime.agent_id.clone(),
                    entity_id: entity_id.clone(),
                    category: ex.category,
                    content: ex.content,
                    confidence: ex.confidence,
                    source: Some("conversation".to_string()),
                    metadata: serde_json::json!({ "roomId": room_id.to_string() }),
                };
                ms.store_long_term_memory_db(&runtime, &memory).await;
            }
        }

        let current_message_count = count_room_messages(&runtime, room_id.clone()).await;
        ms.set_last_extraction_checkpoint_db(&runtime, &entity_id, &room_id, current_message_count)
            .await;
        Ok(None)
    }
}

fn chrono_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

async fn get_room_messages(runtime: &AgentRuntime, room_id: UUID, limit: i32) -> Vec<Memory> {
    let Some(adapter) = runtime.get_adapter() else {
        return Vec::new();
    };
    adapter
        .get_memories(GetMemoriesParams {
            table_name: "messages".to_string(),
            room_id: Some(room_id),
            count: Some(limit),
            unique: Some(false),
            ..Default::default()
        })
        .await
        .unwrap_or_default()
}

async fn count_room_messages(runtime: &AgentRuntime, room_id: UUID) -> i32 {
    get_room_messages(runtime, room_id, 10_000).await.len() as i32
}

/// Create the built-in advanced memory plugin (providers + evaluators).
pub fn create_advanced_memory_plugin(runtime: Weak<AgentRuntime>) -> Plugin {
    Plugin::new(
        "memory",
        "Memory management with conversation summarization and long-term persistent memory",
    )
    .with_provider(Arc::new(LongTermMemoryProvider {
        runtime: runtime.clone(),
    }))
    .with_provider(Arc::new(ContextSummaryProvider {
        runtime: runtime.clone(),
    }))
    .with_evaluator(Arc::new(SummarizationEvaluator {
        runtime: runtime.clone(),
    }))
    .with_evaluator(Arc::new(LongTermExtractionEvaluator { runtime }))
}
