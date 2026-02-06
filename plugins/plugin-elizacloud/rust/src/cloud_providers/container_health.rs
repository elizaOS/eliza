//! containerHealthProvider — Container health in agent state.

use crate::cloud_types::{ContainerBillingStatus, ContainerStatus, ProviderResult};
use crate::services::CloudContainerService;

/// Get ElizaCloud container health status.
pub fn get_container_health(
    authenticated: bool,
    container_svc: Option<&CloudContainerService>,
) -> ProviderResult {
    if !authenticated {
        return ProviderResult {
            text: String::new(),
            values: None,
            data: None,
        };
    }

    let running: Vec<_> = container_svc
        .map(|svc| {
            svc.tracked_containers()
                .into_iter()
                .filter(|c| c.status == ContainerStatus::Running)
                .collect()
        })
        .unwrap_or_default();

    if running.is_empty() {
        return ProviderResult {
            text: "No running containers.".to_string(),
            values: Some(serde_json::json!({"healthyContainers": 0})),
            data: None,
        };
    }

    let reports: Vec<serde_json::Value> = running
        .iter()
        .map(|c| {
            let healthy = c.billing_status == ContainerBillingStatus::Active;
            serde_json::json!({
                "id": c.id,
                "name": c.name,
                "healthy": healthy,
                "billing": format!("{:?}", c.billing_status).to_lowercase(),
            })
        })
        .collect();

    let healthy_count = reports
        .iter()
        .filter(|r| r["healthy"].as_bool().unwrap_or(false))
        .count();

    let mut lines = vec![format!(
        "Health: {}/{} healthy",
        healthy_count,
        reports.len()
    )];

    for r in &reports {
        let name = r["name"].as_str().unwrap_or("?");
        let healthy = r["healthy"].as_bool().unwrap_or(false);
        let billing = r["billing"].as_str().unwrap_or("?");
        let status_str = if healthy { "OK" } else { "UNHEALTHY" };
        lines.push(format!("  - {}: {} ({})", name, status_str, billing));
    }

    ProviderResult {
        text: lines.join("\n"),
        values: Some(serde_json::json!({
            "healthyContainers": healthy_count,
            "unhealthyContainers": reports.len() - healthy_count,
        })),
        data: Some(serde_json::json!({"reports": reports})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unauthenticated() {
        let result = get_container_health(false, None);
        assert!(result.text.is_empty());
    }

    #[test]
    fn test_no_running_containers() {
        let svc = CloudContainerService::new();
        let result = get_container_health(true, Some(&svc));
        assert!(result.text.contains("No running containers"));
    }
}
