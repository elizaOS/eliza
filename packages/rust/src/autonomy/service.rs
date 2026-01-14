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

use crate::runtime::{AgentRuntime, Service};
use crate::services::IMessageService;
use crate::types::database::GetMemoriesParams;
use crate::types::environment::{ChannelType, Room, World};
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

        // Always spawn the background loop (it is gated by AUTONOMY_ENABLED).
        svc.spawn_loop().await;

        Ok(svc)
    }

    pub fn autonomous_room_id(&self) -> UUID {
        self.autonomous_room_id.clone()
    }

    pub fn is_loop_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    pub fn is_thinking_in_progress(&self) -> bool {
        self.is_thinking.load(Ordering::SeqCst)
    }

    pub fn get_loop_interval(&self) -> u64 {
        self.interval_ms.load(Ordering::SeqCst)
    }

    pub fn set_loop_interval(&self, ms: u64) {
        const MIN: u64 = 5_000;
        const MAX: u64 = 600_000;
        self.interval_ms.store(ms.clamp(MIN, MAX), Ordering::SeqCst);
    }

    pub async fn enable_autonomy(&self) {
        if let Some(rt) = self.runtime.upgrade() {
            rt.set_setting("AUTONOMY_ENABLED", SettingValue::Bool(true), false)
                .await;
        }
    }

    pub async fn disable_autonomy(&self) {
        if let Some(rt) = self.runtime.upgrade() {
            rt.set_setting("AUTONOMY_ENABLED", SettingValue::Bool(false), false)
                .await;
        }
        self.stop_loop().await;
    }

    pub fn get_status(&self) -> AutonomyStatus {
        AutonomyStatus {
            enabled: self.is_running.load(Ordering::SeqCst),
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
                // Settings-based enable/disable (parity with TS monitoring)
                let enabled = svc.get_setting_truthy("AUTONOMY_ENABLED").await;
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

    async fn get_setting_truthy(&self, key: &str) -> bool {
        let Some(rt) = self.runtime.upgrade() else {
            return false;
        };
        let v = rt.get_setting(key).await;
        match v {
            Some(SettingValue::Bool(b)) => b,
            Some(SettingValue::String(s)) => {
                let t = s.trim().to_lowercase();
                matches!(t.as_str(), "true" | "1" | "yes" | "on")
            }
            Some(SettingValue::Number(n)) => n != 0.0,
            _ => false,
        }
    }

    async fn ensure_autonomous_context(&self) -> Result<()> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(());
        };
        let Some(adapter) = rt.get_adapter() else {
            return Ok(());
        };

        // Ensure world exists
        if adapter.get_world(&self.autonomous_world_id).await?.is_none() {
            let world = World {
                id: self.autonomous_world_id.clone(),
                name: Some("Autonomy World".to_string()),
                agent_id: rt.agent_id.clone(),
                message_server_id: Some(UUID::default_uuid()),
                metadata: Some(crate::types::environment::WorldMetadata {
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
                room_type: ChannelType::SelfChannel,
                channel_id: Some("autonomous".to_string()),
                message_server_id: Some(UUID::default_uuid()),
                world_id: Some(self.autonomous_world_id.clone()),
                metadata: Some(HashMap::from([(
                    "description".to_string(),
                    Value::String("Room for autonomous agent thinking".to_string()),
                )])),
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

    fn create_monologue_prompt(&self, last_thought: Option<&str>, is_first: bool) -> String {
        if is_first {
            return "As an AI agent, reflect on your current state and experiences. What are you thinking about right now? What interests you or concerns you? Share your internal thoughts as a stream of consciousness. Don't address anyone - this is your private monologue.\n\nGenerate a thoughtful, introspective response (1-2 sentences):".to_string();
        }

        match last_thought {
            Some(t) => format!(
                "Continuing your internal monologue from your last thought: \"{}\"\n\nWhat naturally follows from this thought? What does it make you think about next? Continue your stream of consciousness without addressing anyone - this is your private internal reflection.\n\nGenerate your next thought (1-2 sentences):",
                t
            ),
            None => "As an AI agent, reflect on your current state and experiences. What are you thinking about right now? What interests you or concerns you? Share your internal thoughts as a stream of consciousness. Don't address anyone - this is your private monologue.\n\nGenerate a thoughtful, introspective response (1-2 sentences):".to_string(),
        }
    }

    async fn perform_autonomous_think(&self) -> Result<()> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(());
        };

        let last_thought = self.get_last_autonomous_thought(&rt).await;
        let is_first = last_thought.as_deref().unwrap_or("").is_empty();
        let prompt = self.create_monologue_prompt(last_thought.as_deref(), is_first);

        let mut content = Content::default();
        content.text = Some(prompt);
        content.source = Some("autonomy-service".to_string());
        content.channel_type = Some(ChannelType::SelfChannel);
        content
            .extra
            .insert("isAutonomous".to_string(), Value::Bool(true));
        content
            .extra
            .insert("isInternalThought".to_string(), Value::Bool(true));
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        content
            .extra
            .insert("timestamp".to_string(), Value::Number(Number::from(ts_ms)));

        let mut msg = crate::types::memory::Memory::new(rt.agent_id.clone(), self.autonomous_room_id.clone(), content);
        msg.world_id = Some(self.autonomous_world_id.clone());
        msg.agent_id = Some(rt.agent_id.clone());

        let callback: crate::types::components::HandlerCallback = Arc::new(|_content: Content| {
            Box::pin(async move { Ok(Vec::new()) })
        });

        let service = rt.message_service();
        let _ = service
            .handle_message(rt.as_ref(), &mut msg, Some(callback), None)
            .await?;

        Ok(())
    }

    async fn get_last_autonomous_thought(&self, rt: &AgentRuntime) -> Option<String> {
        let Some(adapter) = rt.get_adapter() else {
            return None;
        };
        let params = GetMemoriesParams {
            room_id: Some(self.autonomous_room_id.clone()),
            count: Some(3),
            table_name: "messages".to_string(),
            ..Default::default()
        };
        let memories = adapter.get_memories(params).await.ok()?;
        let mut candidates: Vec<_> = memories
            .into_iter()
            .filter(|m| {
                m.entity_id == rt.agent_id
                    && m.content.extra.get("isAutonomous").and_then(Value::as_bool) == Some(true)
                    && m.content.text.as_deref().unwrap_or("").trim().len() > 0
            })
            .collect();
        candidates.sort_by_key(|m| m.created_at.unwrap_or(0));
        candidates
            .last()
            .and_then(|m| m.content.text.clone())
            .map(|s| s.trim().to_string())
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

