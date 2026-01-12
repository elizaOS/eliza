#![allow(missing_docs)]

use serde_json::json;

use crate::error::Result;
use crate::service::LinearService;
use crate::types::*;

pub async fn get_issues_context(service: &LinearService) -> Result<ProviderResult> {
    let filters = SearchFilters {
        limit: Some(10),
        ..Default::default()
    };

    let issues = service.search_issues(filters).await?;

    if issues.is_empty() {
        return Ok(ProviderResult::new("No recent Linear issues found"));
    }

    let issues_list: Vec<String> = issues
        .iter()
        .map(|issue| {
            let state = issue
                .state
                .as_ref()
                .map(|s| s.name.as_str())
                .unwrap_or("Unknown");
            let assignee = issue
                .assignee
                .as_ref()
                .map(|a| a.name.as_str())
                .unwrap_or("Unassigned");

            format!(
                "- {}: {} ({}, {})",
                issue.identifier, issue.title, state, assignee
            )
        })
        .collect();

    let text = format!("Recent Linear Issues:\n{}", issues_list.join("\n"));

    Ok(ProviderResult::with_data(
        text,
        json!({
            "issues": issues.iter().map(|i| json!({
                "id": i.id,
                "identifier": i.identifier,
                "title": i.title,
            })).collect::<Vec<_>>()
        }),
    ))
}

pub async fn get_teams_context(service: &LinearService) -> Result<ProviderResult> {
    let teams = service.get_teams().await?;

    if teams.is_empty() {
        return Ok(ProviderResult::new("No Linear teams found"));
    }

    let teams_list: Vec<String> = teams
        .iter()
        .map(|team| {
            let desc = team.description.as_deref().unwrap_or("No description");
            format!("- {} ({}): {}", team.name, team.key, desc)
        })
        .collect();

    let text = format!("Linear Teams:\n{}", teams_list.join("\n"));

    Ok(ProviderResult::with_data(
        text,
        json!({
            "teams": teams.iter().map(|t| json!({
                "id": t.id,
                "name": t.name,
                "key": t.key,
            })).collect::<Vec<_>>()
        }),
    ))
}

pub async fn get_projects_context(service: &LinearService) -> Result<ProviderResult> {
    let projects = service.get_projects(None).await?;

    if projects.is_empty() {
        return Ok(ProviderResult::new("No Linear projects found"));
    }

    let active_projects: Vec<_> = projects
        .iter()
        .filter(|p| {
            p.state
                .as_ref()
                .map(|s| s == "started" || s == "planned")
                .unwrap_or(true)
        })
        .take(10)
        .collect();

    let projects_list: Vec<String> = active_projects
        .iter()
        .map(|project| {
            let state = project.state.as_deref().unwrap_or("active");
            let dates = format!(
                "{} - {}",
                project
                    .start_date
                    .as_ref()
                    .map(|d| &d[..10])
                    .unwrap_or("No start date"),
                project
                    .target_date
                    .as_ref()
                    .map(|d| &d[..10])
                    .unwrap_or("No target date")
            );

            format!("- {}: {} ({})", project.name, state, dates)
        })
        .collect();

    let text = format!("Active Linear Projects:\n{}", projects_list.join("\n"));

    Ok(ProviderResult::with_data(
        text,
        json!({
            "projects": active_projects.iter().map(|p| json!({
                "id": p.id,
                "name": p.name,
                "state": p.state,
            })).collect::<Vec<_>>()
        }),
    ))
}

pub async fn get_activity_context(service: &LinearService) -> Result<ProviderResult> {
    let activity = service.get_activity_log(Some(10));

    if activity.is_empty() {
        return Ok(ProviderResult::new("No recent Linear activity"));
    }

    let activity_list: Vec<String> = activity
        .iter()
        .map(|item| {
            let status = if item.success { "✓" } else { "✗" };
            let time = item.timestamp.format("%H:%M").to_string();

            format!(
                "{} {}: {} {} {}",
                status, time, item.action, item.resource_type, item.resource_id
            )
        })
        .collect();

    let text = format!("Recent Linear Activity:\n{}", activity_list.join("\n"));

    Ok(ProviderResult::with_data(
        text,
        json!({
            "activity": activity.iter().map(|a| json!({
                "id": a.id,
                "action": a.action,
                "resource_type": a.resource_type.to_string(),
                "success": a.success,
            })).collect::<Vec<_>>()
        }),
    ))
}
