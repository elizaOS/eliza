//! Autonomy actions.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use anyhow::Result;
use serde_json::Value;

use crate::autonomy::service::AutonomyService;
use crate::runtime::AgentRuntime;
use crate::types::components::{ActionDefinition, ActionHandler, ActionResult, HandlerOptions};
use crate::types::memory::Memory;
use crate::types::settings::SettingValue;
use crate::types::state::State;

/// SEND_TO_ADMIN action (restricted to autonomous room).
pub struct SendToAdminAction {
    runtime: Weak<AgentRuntime>,
    service: Arc<AutonomyService>,
}

impl SendToAdminAction {
    /// Create a new send-to-admin action handler.
    pub fn new(runtime: Weak<AgentRuntime>, service: Arc<AutonomyService>) -> Self {
        Self { runtime, service }
    }
}

#[async_trait::async_trait]
impl ActionHandler for SendToAdminAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "SEND_TO_ADMIN".to_string(),
            description: "Send a message directly to the admin user from autonomous context"
                .to_string(),
            similes: None,
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        // Only allow in autonomous room, and only if admin configured.
        if message.room_id != self.service.autonomous_room_id() {
            return false;
        }
        let Some(rt) = self.runtime.upgrade() else {
            return false;
        };
        matches!(rt.get_setting("ADMIN_USER_ID").await, Some(SettingValue::String(s)) if !s.trim().is_empty())
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(rt) = self.runtime.upgrade() else {
            return Ok(Some(ActionResult::failure("Runtime unavailable")));
        };

        if message.room_id != self.service.autonomous_room_id() {
            return Ok(Some(ActionResult::failure(
                "Send to admin only available in autonomous context",
            )));
        }

        let admin_user_id = match rt.get_setting("ADMIN_USER_ID").await {
            Some(SettingValue::String(s)) if !s.trim().is_empty() => s,
            _ => {
                return Ok(Some(ActionResult::failure(
                    "No admin user configured. Set ADMIN_USER_ID in settings.",
                )));
            }
        };

        let autonomous_thought = message.content.text.clone().unwrap_or_default();
        let message_to_admin = format!("Autonomous update: {}", autonomous_thought);

        if let Some(adapter) = rt.get_adapter() {
            let mut content = crate::types::primitives::Content {
                text: Some(message_to_admin.clone()),
                source: Some("autonomy-to-admin".to_string()),
                ..Default::default()
            };
            content.extra.insert(
                "adminUserId".to_string(),
                Value::String(admin_user_id.clone()),
            );

            let mut mem = Memory::new(rt.agent_id.clone(), rt.agent_id.clone(), content);
            mem.agent_id = Some(rt.agent_id.clone());
            let _ = adapter.create_memory(&mem, "messages").await?;
        }

        let mut data: HashMap<String, Value> = HashMap::new();
        data.insert("adminUserId".to_string(), Value::String(admin_user_id));
        data.insert("sent".to_string(), Value::Bool(true));

        Ok(Some(ActionResult {
            success: true,
            text: Some("Message sent to admin".to_string()),
            values: None,
            data: Some(data),
            error: None,
        }))
    }
}
