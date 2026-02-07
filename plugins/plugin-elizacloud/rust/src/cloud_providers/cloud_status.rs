//! cloudStatusProvider — Container and connection status in agent state.

use crate::cloud_types::{ContainerStatus, ProviderResult};
use crate::services::{CloudBridgeService, CloudContainerService};

/// Get ElizaCloud container and connection status.
pub fn get_cloud_status(
    authenticated: bool,
    container_svc: Option<&CloudContainerService>,
    bridge_svc: Option<&CloudBridgeService>,
) -> ProviderResult {
    if !authenticated {
        return ProviderResult {
            text: "ElizaCloud: Not authenticated".to_string(),
            values: Some(serde_json::json!({"cloudAuthenticated": false})),
            data: None,
        };
    }

    let containers = container_svc
        .map(|svc| svc.tracked_containers())
        .unwrap_or_default();
    let connected = bridge_svc
        .map(|svc| svc.connected_container_ids())
        .unwrap_or_default();

    let running = containers
        .iter()
        .filter(|c| c.status == ContainerStatus::Running)
        .count();
    let deploying = containers
        .iter()
        .filter(|c| {
            matches!(
                c.status,
                ContainerStatus::Pending | ContainerStatus::Building | ContainerStatus::Deploying
            )
        })
        .count();

    let summaries: Vec<serde_json::Value> = containers
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "name": c.name,
                "status": c.status,
                "url": c.load_balancer_url,
                "billing": c.billing_status,
                "bridged": connected.contains(&c.id),
            })
        })
        .collect();

    let mut lines = vec![format!(
        "ElizaCloud: {} container(s), {} running, {} bridged",
        containers.len(),
        running,
        connected.len()
    )];

    for c in &containers {
        let mut line = format!("  - {} [{}]", c.name, c.status);
        if let Some(ref url) = c.load_balancer_url {
            line.push_str(&format!(" @ {}", url));
        }
        if connected.contains(&c.id) {
            line.push_str(" (bridged)");
        }
        lines.push(line);
    }

    ProviderResult {
        text: lines.join("\n"),
        values: Some(serde_json::json!({
            "cloudAuthenticated": true,
            "totalContainers": containers.len(),
            "runningContainers": running,
            "deployingContainers": deploying,
        })),
        data: Some(serde_json::json!({"containers": summaries})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unauthenticated() {
        let result = get_cloud_status(false, None, None);
        assert!(result.text.contains("Not authenticated"));
    }

    #[test]
    fn test_no_containers() {
        let container_svc = CloudContainerService::new();
        let result = get_cloud_status(true, Some(&container_svc), None);
        assert!(result.text.contains("0 container(s)"));
    }
}
