//! Autonomy service using the Task system (TypeScript parity).
//!
//! This service registers an `AUTONOMY_THINK` task worker and creates a recurring
//! task that triggers autonomous thinking at a configurable interval.

use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use anyhow::Result;
use serde_json::{Number, Value};
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
use crate::types::task::{Task, TaskWorker};

use super::types::AutonomyStatus;

/// Service type constant for autonomy (parity with TS).
pub const AUTONOMY_SERVICE_TYPE: &str = "AUTONOMY";

/// Task name for autonomy thinking (parity with TypeScript).
pub const AUTONOMY_TASK_NAME: &str = "AUTONOMY_THINK";

/// Tags used for autonomy tasks (parity with TypeScript).
/// Note: TypeScript uses ["repeat", "autonomy", "internal"] without "queue".
pub const AUTONOMY_TASK_TAGS: &[&str] = &["repeat", "autonomy", "internal"];

/// Default interval for autonomy loop in milliseconds.
const DEFAULT_INTERVAL_MS: i64 = 30_000;

/// Autonomous world ID (stable).
fn autonomy_world_id() -> UUID {
    UUID::new("00000000-0000-0000-0000-000000000001").expect("valid uuid")
}

/// AutonomyService - manages autonomous agent operation using the Task system.
pub struct AutonomyService {
    runtime: Weak<AgentRuntime>,
    is_running: AtomicBool,
    is_thinking: AtomicBool,
    interval_ms: std::sync::atomic::AtomicI64,
    autonomous_room_id: UUID,
    autonomous_world_id: UUID,
    task_registered: AtomicBool,
}

#[derive(Clone, Copy)]
enum AutonomyMode {
    Continuous,
    Task,
}

impl AutonomyService {
    /// Create and start the autonomy service.
    pub async fn start(runtime: Weak<AgentRuntime>) -> Result<Arc<Self>> {
        let autonomous_room_id = UUID::new_v4();
        let svc = Arc::new(AutonomyService {
            runtime: runtime.clone(),
            is_running: AtomicBool::new(false),
            is_thinking: AtomicBool::new(false),
            interval_ms: std::sync::atomic::AtomicI64::new(DEFAULT_INTERVAL_MS),
            autonomous_room_id,
            autonomous_world_id: autonomy_world_id(),
            task_registered: AtomicBool::new(false),
        });

        svc.ensure_autonomous_context().await?;

        // Register the task worker
        svc.register_autonomy_task_worker().await;

        // Check if autonomy should auto-start
        if svc.runtime_enable_autonomy() {
            info!(
                target: "autonomy",
                "Autonomy enabled, creating autonomy task..."
            );
            svc.create_autonomy_task().await?;
        } else {
            info!(
                target: "autonomy",
                "Autonomy not enabled. Set enableAutonomy: true to auto-start."
            );
        }

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
    pub fn get_loop_interval(&self) -> i64 {
        self.interval_ms.load(Ordering::SeqCst)
    }

    /// Update the loop interval (clamped to a safe range).
    /// Recreates the task if autonomy is currently running (parity with TypeScript).
    pub async fn set_loop_interval(&self, ms: i64) {
        const MIN: i64 = 5_000;
        const MAX: i64 = 600_000;
        let clamped = ms.clamp(MIN, MAX);
        self.interval_ms.store(clamped, Ordering::SeqCst);

        if let Some(rt) = self.runtime.upgrade() {
            info!(
                target: "autonomy",
                agent_id = %rt.agent_id,
                interval_ms = clamped,
                "Loop interval set"
            );
        }

        // Recreate the task if running (parity with TypeScript)
        if self.is_running.load(Ordering::SeqCst) {
            if let Err(e) = self.create_autonomy_task().await {
                warn!(target: "autonomy", error = %e, "Failed to recreate autonomy task after interval change");
            }
        }
    }

    /// Enable autonomy by creating the task.
    pub async fn enable_autonomy(&self) -> Result<()> {
        if let Some(rt) = self.runtime.upgrade() {
            rt.set_enable_autonomy(true);
        }
        self.create_autonomy_task().await
    }

    /// Disable autonomy by removing the task.
    pub async fn disable_autonomy(&self) -> Result<()> {
        if let Some(rt) = self.runtime.upgrade() {
            rt.set_enable_autonomy(false);
            self.remove_autonomy_task(&rt).await?;
        }
        self.is_running.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Get a snapshot of the current autonomy status.
    pub fn get_status(&self) -> AutonomyStatus {
        let enabled = self.runtime_enable_autonomy();
        AutonomyStatus {
            enabled,
            running: self.is_running.load(Ordering::SeqCst),
            thinking: self.is_thinking.load(Ordering::SeqCst),
            interval: self.interval_ms.load(Ordering::SeqCst) as u64,
            autonomous_room_id: self.autonomous_room_id.clone(),
        }
    }

    /// Register the task worker for autonomous thinking.
    async fn register_autonomy_task_worker(self: &Arc<Self>) {
        if self.task_registered.swap(true, Ordering::SeqCst) {
            return; // Already registered
        }

        let Some(rt) = self.runtime.upgrade() else {
            return;
        };

        let service = Arc::clone(self);
        let worker = AutonomyTaskWorker { service };

        rt.register_task_worker(Arc::new(worker)).await;

        debug!(
            target: "autonomy",
            agent_id = %rt.agent_id,
            "Registered autonomy task worker"
        );
    }

    /// Create the recurring autonomy task.
    async fn create_autonomy_task(&self) -> Result<()> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(());
        };

        // Remove any existing autonomy tasks
        self.remove_autonomy_task(&rt).await?;

        // Create the recurring task
        let interval = self.interval_ms.load(Ordering::SeqCst);
        let mut task = Task::repeating(AUTONOMY_TASK_NAME, interval);
        task.description = Some(format!("Autonomous thinking for agent {}", rt.agent_id));
        task.world_id = Some(self.autonomous_world_id.clone());
        task.room_id = Some(self.autonomous_room_id.clone());
        task.tags = Some(AUTONOMY_TASK_TAGS.iter().map(|s| s.to_string()).collect());

        // Ensure metadata has blocking = true
        if let Some(ref mut metadata) = task.metadata {
            metadata.blocking = Some(true);
        }

        rt.create_task(task).await;

        self.is_running.store(true, Ordering::SeqCst);

        info!(
            target: "autonomy",
            agent_id = %rt.agent_id,
            interval_ms = interval,
            "Created autonomy task"
        );

        Ok(())
    }

    /// Remove existing autonomy tasks.
    /// Uses full AUTONOMY_TASK_TAGS for filtering (parity with TypeScript).
    async fn remove_autonomy_task(&self, rt: &AgentRuntime) -> Result<()> {
        let tags: Vec<String> = AUTONOMY_TASK_TAGS.iter().map(|s| s.to_string()).collect();
        let existing_tasks = rt.get_tasks(Some(tags)).await;

        for task in existing_tasks {
            if task.name == AUTONOMY_TASK_NAME {
                if let Some(task_id) = &task.id {
                    rt.delete_task(&task_id.to_string()).await;
                    debug!(
                        target: "autonomy",
                        agent_id = %rt.agent_id,
                        task_id = %task_id,
                        "Removed existing autonomy task"
                    );
                }
            }
        }

        Ok(())
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

    /// Perform one iteration of autonomous thinking.
    /// This is called by the task worker when the task executes.
    pub async fn perform_autonomous_think(&self) -> Result<()> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(());
        };

        // Guard against overlapping think cycles
        if self.is_thinking.swap(true, Ordering::SeqCst) {
            debug!(
                target: "autonomy",
                "Previous think cycle still in progress, skipping"
            );
            return Ok(());
        }

        let result = self.do_think(&rt).await;

        self.is_thinking.store(false, Ordering::SeqCst);

        result
    }

    async fn do_think(&self, rt: &AgentRuntime) -> Result<()> {
        let last_thought = self.get_last_autonomous_thought(rt).await;
        let is_first = last_thought.as_deref().unwrap_or("").is_empty();
        let mode = self.get_autonomy_mode(rt).await;
        let target_context = self.get_target_room_context_text(rt).await;
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
            .handle_message(rt, &mut msg, Some(callback), None)
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

/// Task worker for autonomous thinking.
struct AutonomyTaskWorker {
    service: Arc<AutonomyService>,
}

#[async_trait::async_trait]
impl TaskWorker for AutonomyTaskWorker {
    fn name(&self) -> &str {
        AUTONOMY_TASK_NAME
    }

    async fn execute(
        &self,
        _runtime: Arc<dyn Any + Send + Sync>,
        _options: HashMap<String, serde_json::Value>,
        task: Task,
    ) -> Result<()> {
        let start_time = std::time::Instant::now();

        debug!(
            target: "autonomy",
            task_id = ?task.id,
            "Executing autonomy task"
        );

        let result = self.service.perform_autonomous_think().await;

        let duration_ms = start_time.elapsed().as_millis();

        match &result {
            Ok(_) => {
                debug!(
                    target: "autonomy",
                    task_id = ?task.id,
                    duration_ms = duration_ms,
                    "Autonomy task completed successfully"
                );
            }
            Err(e) => {
                warn!(
                    target: "autonomy",
                    task_id = ?task.id,
                    error = %e,
                    duration_ms = duration_ms,
                    "Autonomy task failed"
                );
            }
        }

        result
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
        self.is_running.store(false, Ordering::SeqCst);

        // Remove the autonomy task
        if let Some(rt) = self.runtime.upgrade() {
            let _ = self.remove_autonomy_task(&rt).await;
        }

        info!(target: "autonomy", "Autonomy service stopped");
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
    fn test_task_constants() {
        assert_eq!(AUTONOMY_TASK_NAME, "AUTONOMY_THINK");
        assert!(AUTONOMY_TASK_TAGS.contains(&"repeat"));
        assert!(AUTONOMY_TASK_TAGS.contains(&"autonomy"));
        assert!(AUTONOMY_TASK_TAGS.contains(&"internal"));
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
