//! Task context provider for the Agent Orchestrator plugin.

use crate::service::{AgentOrchestratorService, Runtime};
use serde_json::json;

/// Provider definition
pub const TASK_CONTEXT_PROVIDER: ProviderDef = ProviderDef {
    name: "TASK_CONTEXT",
    description: "Provides context about active and recent orchestrated tasks",
    position: 90,
};

/// Provider definition
#[derive(Debug, Clone, Copy)]
pub struct ProviderDef {
    pub name: &'static str,
    pub description: &'static str,
    pub position: i32,
}

/// Get task context from the service
pub async fn get_task_context<R: Runtime>(
    service: &AgentOrchestratorService<R>,
) -> serde_json::Value {
    let context_text = match service.get_task_context().await {
        Ok(text) => text,
        Err(_) => "Task orchestrator service error".to_string(),
    };

    let current = service.get_current_task().await.ok().flatten();
    let task_count = service.get_tasks().await.map(|t| t.len()).unwrap_or(0);

    json!({
        "values": {
            "taskContext": context_text,
            "currentTaskName": current.as_ref().map(|t| &t.name).unwrap_or(&"None".to_string()),
            "currentTaskStatus": current.as_ref().map(|t| t.metadata.status.to_string()).unwrap_or_else(|| "N/A".to_string()),
        },
        "text": format!("# Task Context\n\n{}", context_text),
        "data": {
            "taskCount": task_count,
            "currentTaskId": current.as_ref().map(|t| &t.id),
        }
    })
}

/// Add header to content
pub fn add_header(title: &str, content: &str) -> String {
    format!("{}\n\n{}", title, content)
}
