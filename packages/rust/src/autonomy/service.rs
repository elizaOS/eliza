//! Autonomy service (runs an autonomous think loop).

use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{Number, Value};
#[cfg(feature = "native")]
use tokio::task::JoinHandle;
#[cfg(feature = "native")]
use tokio::time::sleep;
use tracing::{debug, info, warn};

use crate::prompts::{
    AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE, AUTONOMY_CONTINUOUS_FIRST_TEMPLATE,
    AUTONOMY_TASK_CONTINUE_TEMPLATE, AUTONOMY_TASK_FIRST_TEMPLATE,
};
use crate::runtime::{AgentRuntime, Service};
use crate::services::IMessageService;
use crate::types::database::GetMemoriesParams;
use crate::types::environment::{Room, RoomMetadata, World, WorldMetadata};
use crate::types::memory::Memory;
use crate::types::primitives::{Content, UUID};
use crate::types::settings::SettingValue;

use super::types::AutonomyStatus;

/// Service type constant for autonomy (parity with TS).
pub const AUTONOMY_SERVICE_TYPE: &str = "AUTONOMY";

/// Autonomous world ID (stable).
fn autonomy_world_id() -> UUID {
    UUID::new("00000000-0000-0000-0000-000000000001").expect("valid uuid")
}

/// AutonomyService - manages autonomous agent operation.
pub struct AutonomyService {
    runtime: Weak<AgentRuntime>,
    is_running: AtomicBool,
    is_thinking: AtomicBool,
    interval_ms: AtomicU64,
    autonomous_room_id: UUID,
    autonomous_world_id: UUID,
    stop_flag: AtomicBool,
    task: Mutex<Option<AutonomyTaskHandle>>,
}

#[derive(Clone, Copy)]
enum AutonomyMode {
    Continuous,
    Task,
}

#[cfg(feature = "native")]
type AutonomyTaskHandle = JoinHandle<()>;
#[cfg(not(feature = "native"))]
type AutonomyTaskHandle = ();

impl AutonomyService {
    /// Create and start the autonomy service (spawns background loop).
    pub async fn start(runtime: Weak<AgentRuntime>) -> Result<Arc<Self>> {
        let autonomous_room_id = UUID::new_v4();
        let svc = Arc::new(AutonomyService {
            runtime,
            is_running: AtomicBool::new(false),
            is_thinking: AtomicBool::new(false),
            interval_ms: AtomicU64::new(30_000),
            autonomous_room_id,
            autonomous_world_id: autonomy_world_id(),
            stop_flag: AtomicBool::new(false),
            task: Mutex::new(None),
        });

        svc.ensure_autonomous_context().await?;

        // Always spawn the background loop (it is gated by runtime.enableAutonomy).
        svc.spawn_loop().await;

        Ok(svc)
    }

    /// Return the autonomous room identifier.
    pub fn autonomous_room_id(&self) -> UUID {
        self.autonomous_room_id.clone()
    }

    /// Whether the autonomy loop is currently running.
    pub fn is_loop_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    /// Whether the agent is actively thinking in the autonomy loop.
    pub fn is_thinking_in_progress(&self) -> bool {
        self.is_thinking.load(Ordering::SeqCst)
    }

    /// Get the current loop interval in milliseconds.
    pub fn get_loop_interval(&self) -> u64 {
        self.interval_ms.load(Ordering::SeqCst)
    }

    /// Update the loop interval (clamped to a safe range).
    pub fn set_loop_interval(&self, ms: u64) {
        const MIN: u64 = 5_000;
        const MAX: u64 = 600_000;
        self.interval_ms.store(ms.clamp(MIN, MAX), Ordering::SeqCst);
    }

    /// Enable autonomy by setting the runtime flag.
    pub async fn enable_autonomy(&self) {
        if let Some(rt) = self.runtime.upgrade() {
            rt.set_enable_autonomy(true);
        }
    }

    /// Disable autonomy and stop the loop.
    pub async fn disable_autonomy(&self) {
        if let Some(rt) = self.runtime.upgrade() {
            rt.set_enable_autonomy(false);
        }
        self.stop_loop().await;
    }

    /// Get a snapshot of the current autonomy status.
    pub fn get_status(&self) -> AutonomyStatus {
        let enabled = self.runtime_enable_autonomy();
        AutonomyStatus {
            enabled,
            running: self.is_running.load(Ordering::SeqCst),
            thinking: self.is_thinking.load(Ordering::SeqCst),
            interval: self.interval_ms.load(Ordering::SeqCst),
            autonomous_room_id: self.autonomous_room_id.clone(),
        }
    }

    async fn spawn_loop(self: &Arc<Self>) {
        #[cfg(not(feature = "native"))]
        {
            // Autonomy loop requires the native async runtime.
            return;
        }
        #[cfg(feature = "native")]
        if self.stop_flag.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(feature = "native")]
        if self.task.lock().expect("lock poisoned").is_some() {
            return;
        }

        #[cfg(feature = "native")]
        let svc = Arc::clone(self);
        #[cfg(feature = "native")]
        let handle: JoinHandle<()> = tokio::spawn(async move {
            let mut last_think = Instant::now() - Duration::from_millis(svc.get_loop_interval());
            while !svc.stop_flag.load(Ordering::SeqCst) {
                // Runtime-based enable/disable (parity with TS monitoring)
                let enabled = svc.runtime_enable_autonomy();
                if !enabled {
                    svc.is_running.store(false, Ordering::SeqCst);
                    sleep(Duration::from_secs(10)).await;
                    continue;
                }

                svc.is_running.store(true, Ordering::SeqCst);

                // Trigger think based on interval
                let interval = Duration::from_millis(svc.get_loop_interval());
                if last_think.elapsed() >= interval && !svc.is_thinking.swap(true, Ordering::SeqCst)
                {
                    if let Err(e) = svc.perform_autonomous_think().await {
                        warn!(error = %e, "autonomy think failed");
                    }
                    svc.is_thinking.store(false, Ordering::SeqCst);
                    last_think = Instant::now();
                }

                sleep(Duration::from_secs(1)).await;
            }
        });

        #[cfg(feature = "native")]
        {
            *self.task.lock().expect("lock poisoned") = Some(handle);
            info!("Autonomy loop started");
        }
    }

    async fn stop_loop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }

    fn runtime_enable_autonomy(&self) -> bool {
        self.runtime
            .upgrade()
            .map(|rt| rt.enable_autonomy())
            .unwrap_or(false)
    }

    async fn ensure_autonomous_context(&self) -> Result<()> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(());
        };
        let Some(adapter) = rt.get_adapter() else {
            return Ok(());
        };

        // Ensure world exists
        if adapter
            .get_world(&self.autonomous_world_id)
            .await?
            .is_none()
        {
            let world = World {
                id: self.autonomous_world_id.clone(),
                name: Some("Autonomy World".to_string()),
                agent_id: rt.agent_id.clone(),
                message_server_id: Some(UUID::default_uuid()),
                metadata: Some(WorldMetadata {
                    extra: HashMap::from([(
                        "type".to_string(),
                        Value::String("autonomy".to_string()),
                    )]),
                    ..Default::default()
                }),
            };
            let _ = adapter.create_world(&world).await?;
        }

        // Ensure room exists
        if adapter.get_room(&self.autonomous_room_id).await?.is_none() {
            let room = Room {
                id: self.autonomous_room_id.clone(),
                name: Some("Autonomous Thoughts".to_string()),
                agent_id: Some(rt.agent_id.clone()),
                source: "autonomy-service".to_string(),
                room_type: "SELF".to_string(),
                channel_id: Some("autonomous".to_string()),
                message_server_id: Some(UUID::default_uuid()),
                world_id: Some(self.autonomous_world_id.clone()),
                metadata: Some(RoomMetadata {
                    values: HashMap::from([(
                        "description".to_string(),
                        Value::String("Room for autonomous agent thinking".to_string()),
                    )]),
                }),
            };
            let _ = adapter.create_room(&room).await?;
        }

        // Ensure agent is a participant
        let _ = adapter
            .add_participant(&rt.agent_id, &self.autonomous_room_id)
            .await?;

        debug!("Ensured autonomy world/room context");
        Ok(())
    }

    async fn get_autonomy_mode(&self, rt: &AgentRuntime) -> AutonomyMode {
        match rt.get_setting("AUTONOMY_MODE").await {
            Some(SettingValue::String(s)) if s.trim().eq_ignore_ascii_case("task") => {
                AutonomyMode::Task
            }
            _ => AutonomyMode::Continuous,
        }
    }

    async fn get_target_room_id(&self, rt: &AgentRuntime) -> Option<UUID> {
        match rt.get_setting("AUTONOMY_TARGET_ROOM_ID").await {
            Some(SettingValue::String(s)) if !s.trim().is_empty() => UUID::new(s.trim()).ok(),
            _ => None,
        }
    }

    fn dedupe_and_sort_memories(memories: Vec<Memory>, messages: Vec<Memory>) -> Vec<Memory> {
        let mut by_id: HashMap<UUID, Memory> = HashMap::new();
        for m in memories.into_iter().chain(messages) {
            let Some(id) = m.id.clone() else {
                continue;
            };
            let replace = match by_id.get(&id) {
                Some(existing) => m.created_at.unwrap_or(0) < existing.created_at.unwrap_or(0),
                None => true,
            };
            if replace {
                by_id.insert(id, m);
            }
        }
        let mut combined: Vec<Memory> = by_id.into_values().collect();
        combined.sort_by_key(|m| m.created_at.unwrap_or(0));
        combined
    }

    fn latest_autonomous_thought(memories: Vec<Memory>, agent_id: &UUID) -> Option<String> {
        memories
            .into_iter()
            .filter(|m| {
                m.entity_id == *agent_id
                    && m.content.extra.get("isAutonomous").and_then(Value::as_bool) == Some(true)
                    && !m.content.text.as_deref().unwrap_or("").trim().is_empty()
            })
            .max_by_key(|m| m.created_at.unwrap_or(0))
            .and_then(|m| m.content.text)
            .map(|s| s.trim().to_string())
    }

    async fn get_target_room_context_text(&self, rt: &AgentRuntime) -> String {
        let Some(adapter) = rt.get_adapter() else {
            return "(no target room configured)".to_string();
        };
        let Some(target_room_id) = self.get_target_room_id(rt).await else {
            return "(no target room configured)".to_string();
        };

        let memories = adapter
            .get_memories(GetMemoriesParams {
                room_id: Some(target_room_id.clone()),
                count: Some(15),
                table_name: "memories".to_string(),
                ..Default::default()
            })
            .await
            .unwrap_or_default();
        let messages = adapter
            .get_memories(GetMemoriesParams {
                room_id: Some(target_room_id.clone()),
                count: Some(15),
                table_name: "messages".to_string(),
                ..Default::default()
            })
            .await
            .unwrap_or_default();

        let combined = Self::dedupe_and_sort_memories(memories, messages);
        let mut lines: Vec<String> = Vec::new();
        for m in combined {
            let role = if m.entity_id == rt.agent_id {
                "Agent"
            } else {
                "User"
            };
            let text = m.content.text.as_deref().unwrap_or("");
            if !text.trim().is_empty() {
                lines.push(format!("{}: {}", role, text));
            }
        }

        if lines.is_empty() {
            "(no recent messages)".to_string()
        } else {
            lines.join("\n")
        }
    }

    fn create_continuous_prompt(
        &self,
        last_thought: Option<&str>,
        is_first: bool,
        target_context: &str,
    ) -> String {
        let template = if is_first {
            AUTONOMY_CONTINUOUS_FIRST_TEMPLATE
        } else {
            AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE
        };
        Self::fill_autonomy_template(template, target_context, last_thought)
    }

    fn create_task_prompt(
        &self,
        last_thought: Option<&str>,
        is_first: bool,
        target_context: &str,
    ) -> String {
        let template = if is_first {
            AUTONOMY_TASK_FIRST_TEMPLATE
        } else {
            AUTONOMY_TASK_CONTINUE_TEMPLATE
        };
        Self::fill_autonomy_template(template, target_context, last_thought)
    }

    fn fill_autonomy_template(
        template: &str,
        target_context: &str,
        last_thought: Option<&str>,
    ) -> String {
        let mut output = template.replace("{{targetRoomContext}}", target_context);
        output = output.replace("{{lastThought}}", last_thought.unwrap_or(""));
        output
    }

    async fn perform_autonomous_think(&self) -> Result<()> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(());
        };

        let last_thought = self.get_last_autonomous_thought(&rt).await;
        let is_first = last_thought.as_deref().unwrap_or("").is_empty();
        let mode = self.get_autonomy_mode(&rt).await;
        let target_context = self.get_target_room_context_text(&rt).await;
        let prompt = match mode {
            AutonomyMode::Task => {
                self.create_task_prompt(last_thought.as_deref(), is_first, &target_context)
            }
            AutonomyMode::Continuous => {
                self.create_continuous_prompt(last_thought.as_deref(), is_first, &target_context)
            }
        };

        let mut content = Content {
            text: Some(prompt),
            source: Some("autonomy-service".to_string()),
            channel_type: Some("SELF".to_string()),
            ..Default::default()
        };
        content
            .extra
            .insert("isAutonomous".to_string(), Value::Bool(true));
        content
            .extra
            .insert("isInternalThought".to_string(), Value::Bool(true));
        let mode_str = match mode {
            AutonomyMode::Task => "task",
            AutonomyMode::Continuous => "continuous",
        };
        content.extra.insert(
            "autonomyMode".to_string(),
            Value::String(mode_str.to_string()),
        );
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        content
            .extra
            .insert("timestamp".to_string(), Value::Number(Number::from(ts_ms)));

        let mut msg = crate::types::memory::Memory::new(
            rt.agent_id.clone(),
            self.autonomous_room_id.clone(),
            content,
        );
        msg.world_id = Some(self.autonomous_world_id.clone());
        msg.agent_id = Some(rt.agent_id.clone());

        let callback: crate::types::components::HandlerCallback =
            Box::new(|_content: Content| Box::pin(async move { Vec::new() }));

        let service = rt.message_service();
        let _ = service
            .handle_message(rt.as_ref(), &mut msg, Some(callback), None)
            .await?;

        Ok(())
    }

    async fn get_last_autonomous_thought(&self, rt: &AgentRuntime) -> Option<String> {
        let adapter = rt.get_adapter()?;
        let params = GetMemoriesParams {
            room_id: Some(self.autonomous_room_id.clone()),
            count: Some(3),
            table_name: "messages".to_string(),
            ..Default::default()
        };
        let memories = adapter.get_memories(params).await.ok()?;
        Self::latest_autonomous_thought(memories, &rt.agent_id)
    }
}

#[async_trait::async_trait]
impl Service for AutonomyService {
    fn service_type(&self) -> &str {
        AUTONOMY_SERVICE_TYPE
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> Result<()> {
        self.stop_flag.store(true, Ordering::SeqCst);
        #[cfg(feature = "native")]
        {
            if let Some(handle) = self.task.lock().expect("lock poisoned").take() {
                handle.abort();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_memory(
        id: UUID,
        created_at: i64,
        entity_id: UUID,
        room_id: UUID,
        text: &str,
        is_autonomous: bool,
    ) -> Memory {
        let mut content = Content::default();
        content.text = Some(text.to_string());
        if is_autonomous {
            content
                .extra
                .insert("isAutonomous".to_string(), Value::Bool(true));
        }
        Memory {
            id: Some(id),
            entity_id,
            agent_id: None,
            created_at: Some(created_at),
            content,
            embedding: None,
            room_id,
            world_id: None,
            unique: None,
            similarity: None,
            metadata: None,
        }
    }

    #[test]
    fn dedupe_and_sort_memories_keeps_earliest_duplicate() {
        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let shared_id = UUID::new_v4();
        let older = build_memory(
            shared_id.clone(),
            10,
            entity_id.clone(),
            room_id.clone(),
            "old",
            false,
        );
        let newer = build_memory(shared_id, 20, entity_id, room_id, "new", false);

        let combined = AutonomyService::dedupe_and_sort_memories(vec![newer], vec![older]);
        assert_eq!(combined.len(), 1);
        assert_eq!(combined[0].created_at, Some(10));
        assert_eq!(combined[0].content.text.as_deref(), Some("old"));
    }

    #[test]
    fn latest_autonomous_thought_uses_latest_timestamp() {
        let agent_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let other_id = UUID::new_v4();
        let first = build_memory(
            UUID::new_v4(),
            5,
            agent_id.clone(),
            room_id.clone(),
            "first",
            true,
        );
        let second = build_memory(
            UUID::new_v4(),
            10,
            agent_id.clone(),
            room_id.clone(),
            "second",
            true,
        );
        let other = build_memory(UUID::new_v4(), 20, other_id, room_id, "other", true);

        let thought =
            AutonomyService::latest_autonomous_thought(vec![other, second, first], &agent_id);
        assert_eq!(thought.as_deref(), Some("second"));
    }
}
