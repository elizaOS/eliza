//! Autonomy providers.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use anyhow::Result;
use serde_json::{Number, Value};

use crate::autonomy::service::AutonomyService;
use crate::runtime::AgentRuntime;
use crate::types::components::{ProviderDefinition, ProviderHandler, ProviderResult};
use crate::types::database::GetMemoriesParams;
use crate::types::memory::Memory;
use crate::types::primitives::UUID;
use crate::types::settings::SettingValue;
use crate::types::state::State;

/// ADMIN_CHAT_HISTORY provider.
///
/// Provides recent conversation history with the admin user for autonomous context.
pub struct AdminChatHistoryProvider {
    runtime: Weak<AgentRuntime>,
    service: Arc<AutonomyService>,
}

impl AdminChatHistoryProvider {
    /// Create a provider for admin chat history in autonomy mode.
    pub fn new(runtime: Weak<AgentRuntime>, service: Arc<AutonomyService>) -> Self {
        Self { runtime, service }
    }
}

#[async_trait::async_trait]
impl ProviderHandler for AdminChatHistoryProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "ADMIN_CHAT_HISTORY".to_string(),
            description: Some(
                "Provides recent conversation history with the admin user for autonomous context"
                    .to_string(),
            ),
            dynamic: Some(false),
            position: None,
            private: None,
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        // Only provide in autonomous room.
        if message.room_id != self.service.autonomous_room_id() {
            return Ok(ProviderResult::default());
        }

        let Some(rt) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(adapter) = rt.get_adapter() else {
            return Ok(ProviderResult::default());
        };

        let admin_user_id = match rt.get_setting("ADMIN_USER_ID").await {
            Some(SettingValue::String(s)) if !s.trim().is_empty() => s,
            _ => {
                return Ok(ProviderResult {
                    text: Some("[ADMIN_CHAT_HISTORY]\nNo admin user configured. Set ADMIN_USER_ID in character settings.\n[/ADMIN_CHAT_HISTORY]".to_string()),
                    data: Some(HashMap::from([("adminConfigured".to_string(), Value::Bool(false))])),
                    values: None,
                });
            }
        };

        let admin_uuid = match UUID::new(admin_user_id.trim()) {
            Ok(u) => u,
            Err(_) => {
                return Ok(ProviderResult {
                    text: Some("[ADMIN_CHAT_HISTORY]\nInvalid ADMIN_USER_ID (expected UUID string).\n[/ADMIN_CHAT_HISTORY]".to_string()),
                    data: Some(HashMap::from([("adminConfigured".to_string(), Value::Bool(false))])),
                    values: None,
                });
            }
        };

        let mut params = GetMemoriesParams {
            entity_id: Some(admin_uuid),
            count: Some(15),
            unique: Some(false),
            table_name: "messages".to_string(),
            ..Default::default()
        };
        // NOTE: parity: include room filter is not always available; leave unset.
        params.room_id = None;

        let mut admin_messages = adapter.get_memories(params).await?;
        if admin_messages.is_empty() {
            return Ok(ProviderResult {
                text: Some("[ADMIN_CHAT_HISTORY]\nNo recent messages found with admin user.\n[/ADMIN_CHAT_HISTORY]".to_string()),
                data: Some(HashMap::from([
                    ("adminConfigured".to_string(), Value::Bool(true)),
                    ("messageCount".to_string(), Value::Number(Number::from(0))),
                ])),
                values: None,
            });
        }

        admin_messages.sort_by_key(|m| m.created_at.unwrap_or(0));
        let start = admin_messages.len().saturating_sub(10);
        let conversation_history = admin_messages
            .iter()
            .skip(start)
            .map(|m| {
                let sender = if m.entity_id == rt.agent_id {
                    "Agent"
                } else {
                    "Admin"
                };
                let ts = m.created_at.unwrap_or(0);
                let text = m.content.text.as_deref().unwrap_or("[No text content]");
                format!("{} {}: {}", ts, sender, text)
            })
            .collect::<Vec<String>>()
            .join("\n");

        Ok(ProviderResult {
            text: Some(format!(
                "[ADMIN_CHAT_HISTORY]\nRecent conversation with admin user ({} total messages):\n\n{}\n[/ADMIN_CHAT_HISTORY]",
                admin_messages.len(),
                conversation_history
            )),
            data: Some(HashMap::from([
                ("adminConfigured".to_string(), Value::Bool(true)),
                (
                    "messageCount".to_string(),
                    Value::Number(Number::from(admin_messages.len() as u64)),
                ),
            ])),
            values: None,
        })
    }
}

/// AUTONOMY_STATUS provider.
///
/// Shows autonomy status in regular conversations (not in the autonomous room).
pub struct AutonomyStatusProvider {
    runtime: Weak<AgentRuntime>,
    service: Arc<AutonomyService>,
}

impl AutonomyStatusProvider {
    /// Create a provider for reporting autonomy status.
    pub fn new(runtime: Weak<AgentRuntime>, service: Arc<AutonomyService>) -> Self {
        Self { runtime, service }
    }
}

#[async_trait::async_trait]
impl ProviderHandler for AutonomyStatusProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "AUTONOMY_STATUS".to_string(),
            description: Some("Provides current autonomy status for agent awareness".to_string()),
            dynamic: Some(false),
            position: None,
            private: None,
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        // Don't show in autonomous room.
        if message.room_id == self.service.autonomous_room_id() {
            return Ok(ProviderResult::default());
        }

        let enabled = self
            .runtime
            .upgrade()
            .map(|rt| rt.enable_autonomy())
            .unwrap_or(false);

        let running = self.service.is_loop_running();
        let interval = self.service.get_loop_interval();

        let status = if running {
            "running autonomously"
        } else if enabled {
            "autonomy enabled but not running"
        } else {
            "autonomy disabled"
        };

        Ok(ProviderResult {
            text: Some(format!(
                "[AUTONOMY_STATUS]\nCurrent status: {}\nThinking interval: {}ms\n[/AUTONOMY_STATUS]",
                status, interval
            )),
            data: Some(HashMap::from([
                ("autonomyEnabled".to_string(), Value::Bool(enabled)),
                ("serviceRunning".to_string(), Value::Bool(running)),
                ("interval".to_string(), Value::Number(Number::from(interval))),
            ])),
            values: None,
        })
    }
}
