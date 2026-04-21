//! FORM_CONTEXT provider — injects active form state into agent context.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::service::FormService;
use super::types::*;

/// Provider that surfaces the current form session state in agent context.
pub struct FormContextProvider {
    service: Arc<FormService>,
}

impl FormContextProvider {
    /// Create a new FormContextProvider.
    pub fn new(service: Arc<FormService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Provider for FormContextProvider {
    fn name(&self) -> &'static str {
        "FORM_CONTEXT"
    }

    fn description(&self) -> &'static str {
        "Active form session state and progress"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let entity_id = match message.entity_id {
            Some(id) => id,
            None => {
                return Ok(ProviderResult::new("").with_value("hasActiveForm", false));
            }
        };
        let room_id = match message.room_id {
            Some(id) => id,
            None => {
                return Ok(ProviderResult::new("").with_value("hasActiveForm", false));
            }
        };

        let session = match self.service.get_active_session(entity_id, room_id).await {
            Some(s) => s,
            None => {
                return Ok(ProviderResult::new("").with_value("hasActiveForm", false));
            }
        };

        let definition = match self.service.get_definition(&session.form_id).await {
            Some(d) => d,
            None => {
                return Ok(ProviderResult::new("").with_value("hasActiveForm", false));
            }
        };

        let progress = FormService::compute_progress(&session, &definition);

        // Build filled fields summary
        let filled: Vec<String> = definition
            .controls
            .iter()
            .filter(|c| {
                session
                    .fields
                    .get(&c.key)
                    .map(|f| f.status == FieldStatus::Filled)
                    .unwrap_or(false)
            })
            .map(|c| {
                let val = session
                    .fields
                    .get(&c.key)
                    .and_then(|f| f.value.as_ref())
                    .map(|v| {
                        if c.sensitive {
                            "***".to_string()
                        } else {
                            v.to_string()
                        }
                    })
                    .unwrap_or_default();
                format!("  - {}: {}", c.label, val)
            })
            .collect();

        // Build missing fields summary
        let missing: Vec<String> = definition
            .controls
            .iter()
            .filter(|c| {
                c.required
                    && session
                        .fields
                        .get(&c.key)
                        .map(|f| f.status != FieldStatus::Filled)
                        .unwrap_or(true)
            })
            .map(|c| {
                let prompt = c.ask_prompt.as_deref().unwrap_or(&c.label);
                format!("  - {} ({})", c.label, prompt)
            })
            .collect();

        let text = format!(
            "# Active Form: {}\nProgress: {:.0}%\nStatus: {:?}\n\n## Filled\n{}\n\n## Missing Required\n{}\n",
            definition.name,
            progress,
            session.status,
            if filled.is_empty() { "  (none)".to_string() } else { filled.join("\n") },
            if missing.is_empty() { "  (none)".to_string() } else { missing.join("\n") },
        );

        Ok(ProviderResult::new(text)
            .with_value("hasActiveForm", true)
            .with_value("formProgress", progress as i64)
            .with_data("formId", serde_json::Value::String(session.form_id))
            .with_data("sessionId", serde_json::Value::String(session.id)))
    }
}
