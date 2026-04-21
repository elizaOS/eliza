//! Clipboard actions — CLIPBOARD_ADD, CLIPBOARD_REMOVE, CLIPBOARD_CLEAR.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::service::ClipboardService;
use super::types::*;

// ============================================================================
// CLIPBOARD_ADD
// ============================================================================

/// Action to add an item to the task clipboard.
pub struct ClipboardAddAction {
    service: Arc<ClipboardService>,
}

impl ClipboardAddAction {
    /// Create a new ClipboardAddAction.
    pub fn new(service: Arc<ClipboardService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for ClipboardAddAction {
    fn name(&self) -> &'static str {
        "CLIPBOARD_ADD"
    }

    fn similes(&self) -> &[&'static str] {
        &["COPY_TO_CLIPBOARD", "SAVE_TO_CLIPBOARD", "CLIP"]
    }

    fn description(&self) -> &'static str {
        "Add an item to the task clipboard for later reference"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .or_else(|| message.content.text.as_deref())
            .unwrap_or("")
            .to_string();

        if content.is_empty() {
            return Ok(ActionResult::error("No content to add to clipboard".to_string()));
        }

        let title = params
            .get("title")
            .and_then(|v| v.as_str())
            .map(String::from);

        let source_type = params
            .get("sourceType")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<TaskClipboardSourceType>(&format!("\"{}\"", s)).ok())
            .unwrap_or(TaskClipboardSourceType::Manual);

        let task_id = message
            .room_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "default".to_string());

        let input = AddTaskClipboardItemInput {
            title,
            content: content.clone(),
            source_type: Some(source_type),
            source_id: params.get("sourceId").and_then(|v| v.as_str()).map(String::from),
            source_label: params.get("sourceLabel").and_then(|v| v.as_str()).map(String::from),
            mime_type: params.get("mimeType").and_then(|v| v.as_str()).map(String::from),
        };

        match self.service.add_task_item(&task_id, input).await {
            Ok(item) => Ok(ActionResult::success(format!(
                "Added '{}' to clipboard",
                item.title
            ))
            .with_data("clipboardItemId", item.id)
            .with_data("actionName", "CLIPBOARD_ADD")),
            Err(e) => Ok(ActionResult::error(format!(
                "Failed to add to clipboard: {}",
                e
            ))),
        }
    }
}

// ============================================================================
// CLIPBOARD_REMOVE
// ============================================================================

/// Action to remove an item from the task clipboard.
pub struct ClipboardRemoveAction {
    service: Arc<ClipboardService>,
}

impl ClipboardRemoveAction {
    /// Create a new ClipboardRemoveAction.
    pub fn new(service: Arc<ClipboardService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for ClipboardRemoveAction {
    fn name(&self) -> &'static str {
        "CLIPBOARD_REMOVE"
    }

    fn similes(&self) -> &[&'static str] {
        &["REMOVE_FROM_CLIPBOARD", "UNCLIP", "DELETE_CLIPBOARD_ITEM"]
    }

    fn description(&self) -> &'static str {
        "Remove an item from the task clipboard"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let item_id = params
            .get("itemId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing itemId parameter".to_string())
            })?;

        let task_id = message
            .room_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "default".to_string());

        let removed = self.service.remove_task_item(&task_id, item_id).await;

        if removed {
            Ok(ActionResult::success("Item removed from clipboard".to_string())
                .with_data("actionName", "CLIPBOARD_REMOVE"))
        } else {
            Ok(ActionResult::error("Clipboard item not found".to_string()))
        }
    }
}

// ============================================================================
// CLIPBOARD_CLEAR
// ============================================================================

/// Action to clear the entire task clipboard.
pub struct ClipboardClearAction {
    service: Arc<ClipboardService>,
}

impl ClipboardClearAction {
    /// Create a new ClipboardClearAction.
    pub fn new(service: Arc<ClipboardService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for ClipboardClearAction {
    fn name(&self) -> &'static str {
        "CLIPBOARD_CLEAR"
    }

    fn similes(&self) -> &[&'static str] {
        &["CLEAR_CLIPBOARD", "EMPTY_CLIPBOARD"]
    }

    fn description(&self) -> &'static str {
        "Clear all items from the task clipboard"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let task_id = message
            .room_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "default".to_string());

        let snapshot = self.service.get_task_clipboard(&task_id).await;
        let count = snapshot.items.len();

        // Remove all items
        for item in &snapshot.items {
            self.service.remove_task_item(&task_id, &item.id).await;
        }

        Ok(ActionResult::success(format!(
            "Cleared {} items from clipboard",
            count
        ))
        .with_data("clearedCount", serde_json::json!(count))
        .with_data("actionName", "CLIPBOARD_CLEAR"))
    }
}
