#![allow(missing_docs)]

use serde_json::json;

use crate::error::Result;
use crate::types::*;

/// Provide plan status context from stored plans
pub fn get_plan_status(plan_texts: &[&str]) -> Result<ProviderResult> {
    if plan_texts.is_empty() {
        return Ok(ProviderResult::new("No active plans"));
    }

    let mut summaries: Vec<String> = Vec::new();
    let mut plan_data: Vec<serde_json::Value> = Vec::new();

    for text in plan_texts {
        if let Some(plan) = decode_plan(text) {
            let progress = get_plan_progress(&plan);
            let completed = plan
                .tasks
                .iter()
                .filter(|t| t.status == TaskStatus::Completed)
                .count();
            let in_progress: Vec<&str> = plan
                .tasks
                .iter()
                .filter(|t| t.status == TaskStatus::InProgress)
                .map(|t| t.title.as_str())
                .collect();

            let mut summary = format!(
                "- {} [{}] {}% ({}/{} tasks)",
                plan.title,
                plan.status,
                progress,
                completed,
                plan.tasks.len()
            );

            if !in_progress.is_empty() {
                summary.push_str(&format!("\n  In progress: {}", in_progress.join(", ")));
            }

            let next_pending = plan
                .tasks
                .iter()
                .find(|t| t.status == TaskStatus::Pending);
            if let Some(next) = next_pending {
                summary.push_str(&format!("\n  Next: {}", next.title));
            }

            summaries.push(summary);

            plan_data.push(json!({
                "id": plan.id,
                "title": plan.title,
                "status": plan.status.to_string(),
                "progress": progress,
                "taskCount": plan.tasks.len(),
                "completedCount": completed,
            }));
        }
    }

    if summaries.is_empty() {
        return Ok(ProviderResult::new("No active plans"));
    }

    let count = summaries.len();
    let text = format!("Active Plans ({}):\n{}", count, summaries.join("\n"));

    Ok(ProviderResult::with_data(
        text,
        json!({
            "plans": plan_data,
            "count": count,
        }),
    ))
}
