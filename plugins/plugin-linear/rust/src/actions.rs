#![allow(missing_docs)]

use serde_json::{json, Value};

use crate::error::{LinearError, Result};
use crate::service::LinearService;
use crate::types::*;

pub type ActionHandler = fn(
    &LinearService,
    Value,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<ActionResult>> + Send + '_>,
>;

pub async fn create_issue(service: &LinearService, params: Value) -> Result<ActionResult> {
    let title = params
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Title is required".to_string()))?;

    let team_id = params
        .get("teamId")
        .and_then(|t| t.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Team ID is required".to_string()))?;

    let input = IssueInput {
        title: title.to_string(),
        team_id: team_id.to_string(),
        description: params
            .get("description")
            .and_then(|d| d.as_str())
            .map(String::from),
        priority: params
            .get("priority")
            .and_then(|p| p.as_i64())
            .map(|p| p as i32),
        assignee_id: params
            .get("assigneeId")
            .and_then(|a| a.as_str())
            .map(String::from),
        label_ids: params
            .get("labelIds")
            .and_then(|l| l.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        project_id: params
            .get("projectId")
            .and_then(|p| p.as_str())
            .map(String::from),
        state_id: params
            .get("stateId")
            .and_then(|s| s.as_str())
            .map(String::from),
        estimate: params
            .get("estimate")
            .and_then(|e| e.as_i64())
            .map(|e| e as i32),
        due_date: None,
    };

    let issue = service.create_issue(input).await?;

    Ok(ActionResult::success_with_data(
        format!("Created issue: {} ({})", issue.title, issue.identifier),
        json!({
            "issueId": issue.id,
            "identifier": issue.identifier,
            "url": issue.url,
        }),
    ))
}

pub async fn get_issue(service: &LinearService, params: Value) -> Result<ActionResult> {
    let issue_id = params
        .get("issueId")
        .and_then(|i| i.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Issue ID is required".to_string()))?;

    let issue = service.get_issue(issue_id).await?;

    let priority_labels = ["", "Urgent", "High", "Normal", "Low"];
    let priority = priority_labels
        .get(issue.priority as usize)
        .unwrap_or(&"No priority");

    let state_name = issue
        .state
        .as_ref()
        .map(|s| s.name.as_str())
        .unwrap_or("No status");

    let team_name = issue
        .team
        .as_ref()
        .map(|t| t.name.as_str())
        .unwrap_or("No team");

    let assignee_name = issue
        .assignee
        .as_ref()
        .map(|a| a.name.as_str())
        .unwrap_or("Unassigned");

    let text = format!(
        "📋 **{}: {}**\n\nStatus: {}\nPriority: {}\nTeam: {}\nAssignee: {}\n\n{}\n\nView in Linear: {}",
        issue.identifier,
        issue.title,
        state_name,
        priority,
        team_name,
        assignee_name,
        issue.description.as_deref().unwrap_or("No description"),
        issue.url,
    );

    Ok(ActionResult::success_with_data(
        text,
        json!({ "issue": issue }),
    ))
}

pub async fn update_issue(service: &LinearService, params: Value) -> Result<ActionResult> {
    let issue_id = params
        .get("issueId")
        .and_then(|i| i.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Issue ID is required".to_string()))?;

    let updates = params.get("updates").cloned().unwrap_or(json!({}));

    let issue = service.update_issue(issue_id, updates).await?;

    Ok(ActionResult::success_with_data(
        format!("Updated issue {}: {}", issue.identifier, issue.title),
        json!({
            "issueId": issue.id,
            "identifier": issue.identifier,
            "url": issue.url,
        }),
    ))
}

pub async fn delete_issue(service: &LinearService, params: Value) -> Result<ActionResult> {
    let issue_id = params
        .get("issueId")
        .and_then(|i| i.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Issue ID is required".to_string()))?;

    let issue = service.get_issue(issue_id).await?;
    let identifier = issue.identifier.clone();
    let title = issue.title.clone();

    service.delete_issue(issue_id).await?;

    Ok(ActionResult::success_with_data(
        format!("Archived issue {}: \"{}\"", identifier, title),
        json!({
            "issueId": issue_id,
            "identifier": identifier,
            "title": title,
            "archived": true,
        }),
    ))
}

pub async fn search_issues(service: &LinearService, params: Value) -> Result<ActionResult> {
    let filters = SearchFilters {
        query: params
            .get("query")
            .and_then(|q| q.as_str())
            .map(String::from),
        team: params
            .get("team")
            .and_then(|t| t.as_str())
            .map(String::from),
        state: params.get("state").and_then(|s| s.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        }),
        priority: params
            .get("priority")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_i64().map(|n| n as i32))
                    .collect()
            }),
        assignee: params
            .get("assignee")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }),
        label: params.get("label").and_then(|l| l.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        }),
        project: params
            .get("project")
            .and_then(|p| p.as_str())
            .map(String::from),
        limit: params
            .get("limit")
            .and_then(|l| l.as_i64())
            .map(|l| l as i32),
    };

    let issues = service.search_issues(filters).await?;

    if issues.is_empty() {
        return Ok(ActionResult::success_with_data(
            "No issues found matching your search criteria.",
            json!({ "issues": [], "count": 0 }),
        ));
    }

    let priority_labels = ["", "Urgent", "High", "Normal", "Low"];
    let issue_list: Vec<String> = issues
        .iter()
        .enumerate()
        .map(|(i, issue)| {
            let state_name = issue
                .state
                .as_ref()
                .map(|s| s.name.as_str())
                .unwrap_or("No state");
            let priority = priority_labels
                .get(issue.priority as usize)
                .unwrap_or(&"No priority");
            let assignee = issue
                .assignee
                .as_ref()
                .map(|a| a.name.as_str())
                .unwrap_or("Unassigned");

            format!(
                "{}. {}: {}\n   Status: {} | Priority: {} | Assignee: {}",
                i + 1,
                issue.identifier,
                issue.title,
                state_name,
                priority,
                assignee
            )
        })
        .collect();

    let text = format!(
        "📋 Found {} issue{}:\n\n{}",
        issues.len(),
        if issues.len() == 1 { "" } else { "s" },
        issue_list.join("\n\n")
    );

    Ok(ActionResult::success_with_data(
        text,
        json!({
            "issues": issues,
            "count": issues.len(),
        }),
    ))
}

pub async fn create_comment(service: &LinearService, params: Value) -> Result<ActionResult> {
    let issue_id = params
        .get("issueId")
        .and_then(|i| i.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Issue ID is required".to_string()))?;

    let body = params
        .get("body")
        .and_then(|b| b.as_str())
        .ok_or_else(|| LinearError::InvalidInput("Comment body is required".to_string()))?;

    let issue = service.get_issue(issue_id).await?;

    let input = CommentInput {
        issue_id: issue.id.clone(),
        body: body.to_string(),
    };

    let comment = service.create_comment(input).await?;

    Ok(ActionResult::success_with_data(
        format!("Comment added to issue {}: \"{}\"", issue.identifier, body),
        json!({
            "commentId": comment.id,
            "issueId": issue.id,
            "issueIdentifier": issue.identifier,
            "commentBody": body,
            "createdAt": comment.created_at,
        }),
    ))
}

pub async fn list_teams(service: &LinearService, _params: Value) -> Result<ActionResult> {
    let teams = service.get_teams().await?;

    if teams.is_empty() {
        return Ok(ActionResult::success("No teams found in Linear."));
    }

    let team_list: Vec<String> = teams
        .iter()
        .enumerate()
        .map(|(i, team)| {
            let desc = team.description.as_deref().unwrap_or("No description");
            format!("{}. {} ({})\n   {}", i + 1, team.name, team.key, desc)
        })
        .collect();

    let text = format!(
        "📋 Found {} team{}:\n\n{}",
        teams.len(),
        if teams.len() == 1 { "" } else { "s" },
        team_list.join("\n\n")
    );

    Ok(ActionResult::success_with_data(
        text,
        json!({
            "teams": teams,
            "count": teams.len(),
        }),
    ))
}

pub async fn list_projects(service: &LinearService, params: Value) -> Result<ActionResult> {
    let team_id = params.get("teamId").and_then(|t| t.as_str());

    let projects = service.get_projects(team_id).await?;

    if projects.is_empty() {
        return Ok(ActionResult::success(if team_id.is_some() {
            "No projects found for the specified team."
        } else {
            "No projects found in Linear."
        }));
    }

    let project_list: Vec<String> = projects
        .iter()
        .enumerate()
        .map(|(i, project)| {
            let status = project.state.as_deref().unwrap_or("Active");
            let progress = project
                .progress
                .map(|p| format!(" ({:.0}% complete)", p * 100.0))
                .unwrap_or_default();
            let teams = project
                .teams
                .as_ref()
                .map(|t| {
                    t.nodes
                        .iter()
                        .map(|team| team.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "No teams".to_string());

            format!(
                "{}. {}{}\n   Status: {}{} | Teams: {}",
                i + 1,
                project.name,
                project
                    .description
                    .as_ref()
                    .map(|d| format!(" - {}", d))
                    .unwrap_or_default(),
                status,
                progress,
                teams
            )
        })
        .collect();

    let text = format!(
        "📁 Found {} project{}:\n\n{}",
        projects.len(),
        if projects.len() == 1 { "" } else { "s" },
        project_list.join("\n\n")
    );

    Ok(ActionResult::success_with_data(
        text,
        json!({
            "projects": projects,
            "count": projects.len(),
        }),
    ))
}

pub async fn get_activity(service: &LinearService, params: Value) -> Result<ActionResult> {
    let limit = params
        .get("limit")
        .and_then(|l| l.as_u64())
        .map(|l| l as usize)
        .unwrap_or(10);

    let activity = service.get_activity_log(Some(limit));

    if activity.is_empty() {
        return Ok(ActionResult::success("No recent Linear activity found."));
    }

    let activity_list: Vec<String> = activity
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let status = if item.success { "✅" } else { "❌" };
            let time = item.timestamp.format("%Y-%m-%d %H:%M").to_string();
            let error_text = item
                .error
                .as_ref()
                .map(|e| format!("\n   Error: {}", e))
                .unwrap_or_default();

            format!(
                "{}. {} {} on {} {}\n   Time: {}{}",
                i + 1,
                status,
                item.action,
                item.resource_type,
                item.resource_id,
                time,
                error_text
            )
        })
        .collect();

    let text = format!(
        "📊 Recent Linear activity:\n\n{}",
        activity_list.join("\n\n")
    );

    Ok(ActionResult::success_with_data(
        text,
        json!({
            "activity": activity,
            "count": activity.len(),
        }),
    ))
}

pub async fn clear_activity(service: &LinearService, _params: Value) -> Result<ActionResult> {
    service.clear_activity_log();
    Ok(ActionResult::success(
        "✅ Linear activity log has been cleared.",
    ))
}
