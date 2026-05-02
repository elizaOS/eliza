//! CLIPBOARD provider — surfaces clipboard content in agent context.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::service::ClipboardService;

/// Provider that surfaces task clipboard items in agent context.
pub struct ClipboardProvider {
    service: Arc<ClipboardService>,
}

impl ClipboardProvider {
    /// Create a new ClipboardProvider.
    pub fn new(service: Arc<ClipboardService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Provider for ClipboardProvider {
    fn name(&self) -> &'static str {
        "CLIPBOARD"
    }

    fn description(&self) -> &'static str {
        "Task clipboard items and working memory"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Use room ID as the task context key
        let task_id = message
            .room_id
            .map(|id| id.to_string())
            .or_else(|| {
                state
                    .and_then(|s| s.get_value("taskId"))
                    .and_then(|v| v.as_str().map(String::from))
            })
            .unwrap_or_else(|| "default".to_string());

        let snapshot = self.service.get_task_clipboard(&task_id).await;

        if snapshot.items.is_empty() {
            return Ok(ProviderResult::new("").with_value("clipboardCount", 0i64));
        }

        let formatted: Vec<String> = snapshot
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                format!(
                    "## [{}/{}] {} ({})\n{}\n",
                    i + 1,
                    snapshot.max_items,
                    item.title,
                    serde_json::to_string(&item.source_type).unwrap_or_default(),
                    item.content.chars().take(500).collect::<String>()
                )
            })
            .collect();

        let text = format!(
            "# Task Clipboard ({}/{})\n{}",
            snapshot.items.len(),
            snapshot.max_items,
            formatted.join("\n")
        );

        Ok(ProviderResult::new(text).with_value("clipboardCount", snapshot.items.len() as i64))
    }
}
