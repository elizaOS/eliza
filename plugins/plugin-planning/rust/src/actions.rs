#![allow(missing_docs)]

use serde_json::{json, Value};

use crate::error::{PlanningError, Result};
use crate::types::*;

/// Handle the CREATE_PLAN action
pub async fn create_plan(params: Value) -> Result<ActionResult> {
    let title = params
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or_else(|| PlanningError::InvalidInput("Plan title is required".to_string()))?;

    let description = params
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("");

    let task_defs: Vec<Value> = params
        .get("tasks")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis();

    let tasks: Vec<Task> = task_defs
        .iter()
        .enumerate()
        .map(|(i, td)| {
            let task_title = td
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("Untitled task")
                .to_string();
            let task_desc = td
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            let deps: Vec<String> = td
                .get("dependencies")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            Task {
                id: generate_task_id(i),
                title: task_title,
                description: task_desc,
                status: TaskStatus::Pending,
                order: (i + 1) as i32,
                dependencies: deps,
                assignee: None,
                created_at: now,
                completed_at: None,
            }
        })
        .collect();

    let plan = Plan {
        id: format!("plan-{}", now),
        title: title.to_string(),
        description: description.to_string(),
        status: PlanStatus::Active,
        tasks: tasks.clone(),
        created_at: now,
        updated_at: now,
        metadata: json!({}),
    };

    let encoded = encode_plan(&plan);
    let formatted = format_plan(&plan);
    let task_count = tasks.len();

    Ok(ActionResult::success_with_data(
        format!(
            "Created plan \"{}\" with {} task{}.\n\n{}",
            title,
            task_count,
            if task_count == 1 { "" } else { "s" },
            formatted
        ),
        json!({
            "planId": plan.id,
            "title": plan.title,
            "taskCount": task_count,
            "encoded": encoded,
        }),
    ))
}

/// Handle the UPDATE_PLAN action
pub async fn update_plan(params: Value) -> Result<ActionResult> {
    let plan_json = params
        .get("plan")
        .and_then(|p| p.as_str())
        .ok_or_else(|| PlanningError::InvalidInput("Plan data is required".to_string()))?;

    let mut plan = decode_plan(plan_json)
        .ok_or_else(|| PlanningError::PlanNotFound("Invalid plan data".to_string()))?;

    if let Some(title) = params.get("title").and_then(|t| t.as_str()) {
        plan.title = title.to_string();
    }
    if let Some(desc) = params.get("description").and_then(|d| d.as_str()) {
        plan.description = desc.to_string();
    }
    if let Some(status) = params.get("status").and_then(|s| s.as_str()) {
        plan.status = match status {
            "draft" => PlanStatus::Draft,
            "active" => PlanStatus::Active,
            "completed" => PlanStatus::Completed,
            "archived" => PlanStatus::Archived,
            _ => plan.status,
        };
    }
    plan.updated_at = chrono::Utc::now().timestamp_millis();

    let encoded = encode_plan(&plan);
    let formatted = format_plan(&plan);

    Ok(ActionResult::success_with_data(
        format!("Updated plan \"{}\".\n\n{}", plan.title, formatted),
        json!({
            "planId": plan.id,
            "title": plan.title,
            "status": plan.status.to_string(),
            "encoded": encoded,
        }),
    ))
}

/// Handle the COMPLETE_TASK action
pub async fn complete_task(params: Value) -> Result<ActionResult> {
    let plan_json = params
        .get("plan")
        .and_then(|p| p.as_str())
        .ok_or_else(|| PlanningError::InvalidInput("Plan data is required".to_string()))?;

    let mut plan = decode_plan(plan_json)
        .ok_or_else(|| PlanningError::PlanNotFound("Invalid plan data".to_string()))?;

    let task_id = params
        .get("taskId")
        .and_then(|t| t.as_str())
        .ok_or_else(|| PlanningError::InvalidInput("Task ID is required".to_string()))?;

    let task_index = plan
        .tasks
        .iter()
        .position(|t| t.id == task_id)
        .ok_or_else(|| PlanningError::TaskNotFound(task_id.to_string()))?;

    if plan.tasks[task_index].status == TaskStatus::Completed {
        return Ok(ActionResult::success(format!(
            "Task \"{}\" is already completed.",
            plan.tasks[task_index].title
        )));
    }

    let now = chrono::Utc::now().timestamp_millis();
    plan.tasks[task_index].status = TaskStatus::Completed;
    plan.tasks[task_index].completed_at = Some(now);
    plan.updated_at = now;

    let progress = get_plan_progress(&plan);
    if progress == 100 {
        plan.status = PlanStatus::Completed;
    }

    let task_title = plan.tasks[task_index].title.clone();
    let encoded = encode_plan(&plan);
    let formatted = format_plan(&plan);

    let completion_note = if progress == 100 {
        " All tasks completed - plan is now finished!"
    } else {
        ""
    };

    Ok(ActionResult::success_with_data(
        format!(
            "Completed task \"{}\" ({}% done).{}\n\n{}",
            task_title, progress, completion_note, formatted
        ),
        json!({
            "planId": plan.id,
            "taskId": task_id,
            "taskTitle": task_title,
            "progress": progress,
            "planCompleted": progress == 100,
            "encoded": encoded,
        }),
    ))
}

/// Handle the GET_PLAN action
pub async fn get_plan(params: Value) -> Result<ActionResult> {
    let plans: Vec<Value> = params
        .get("plans")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    if plans.is_empty() {
        return Ok(ActionResult::success_with_data(
            "No plans found. Create one with CREATE_PLAN.",
            json!({ "plans": [], "count": 0 }),
        ));
    }

    // Check for a specific plan ID
    let plan_id = params.get("planId").and_then(|p| p.as_str());

    if let Some(id) = plan_id {
        for plan_json in &plans {
            if let Some(text) = plan_json.as_str() {
                if let Some(plan) = decode_plan(text) {
                    if plan.id == id {
                        let formatted = format_plan(&plan);
                        let progress = get_plan_progress(&plan);
                        return Ok(ActionResult::success_with_data(
                            formatted,
                            json!({
                                "planId": plan.id,
                                "title": plan.title,
                                "status": plan.status.to_string(),
                                "progress": progress,
                                "taskCount": plan.tasks.len(),
                            }),
                        ));
                    }
                }
            }
        }
    }

    // Show all plans summary
    let mut summaries: Vec<String> = Vec::new();
    for plan_json in &plans {
        if let Some(text) = plan_json.as_str() {
            if let Some(plan) = decode_plan(text) {
                let progress = get_plan_progress(&plan);
                let completed = plan
                    .tasks
                    .iter()
                    .filter(|t| t.status == TaskStatus::Completed)
                    .count();
                summaries.push(format!(
                    "- {} [{}] {}/{} tasks ({}%)",
                    plan.title,
                    plan.status,
                    completed,
                    plan.tasks.len(),
                    progress
                ));
            }
        }
    }

    let count = summaries.len();
    let text = format!("Plans ({}):\n{}", count, summaries.join("\n"));

    Ok(ActionResult::success_with_data(
        text,
        json!({ "count": count }),
    ))
}
