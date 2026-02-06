//! CloudContainerService — Manages container lifecycle through ElizaCloud API.

use std::collections::HashMap;
use tracing::info;

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{
    CloudContainer, CloudPluginConfig, ContainerArchitecture, ContainerBillingStatus,
    ContainerStatus, CreateContainerRequest, CreateContainerResponse,
};
use crate::error::{ElizaCloudError, Result};

/// Parse a raw JSON value into a CloudContainer.
pub fn parse_container(data: &serde_json::Value) -> CloudContainer {
    CloudContainer {
        id: data["id"].as_str().unwrap_or_default().to_string(),
        name: data["name"].as_str().unwrap_or_default().to_string(),
        project_name: data["project_name"].as_str().unwrap_or_default().to_string(),
        description: data["description"].as_str().map(String::from),
        organization_id: data["organization_id"].as_str().unwrap_or_default().to_string(),
        user_id: data["user_id"].as_str().unwrap_or_default().to_string(),
        status: serde_json::from_value(data["status"].clone()).unwrap_or(ContainerStatus::Pending),
        image_tag: data["image_tag"].as_str().map(String::from),
        port: data["port"].as_u64().unwrap_or(3000) as u16,
        desired_count: data["desired_count"].as_u64().unwrap_or(1) as u32,
        cpu: data["cpu"].as_u64().unwrap_or(1792) as u32,
        memory: data["memory"].as_u64().unwrap_or(1792) as u32,
        architecture: serde_json::from_value(data["architecture"].clone())
            .unwrap_or(ContainerArchitecture::Arm64),
        environment_vars: serde_json::from_value(data["environment_vars"].clone())
            .unwrap_or_default(),
        health_check_path: data["health_check_path"]
            .as_str()
            .unwrap_or("/health")
            .to_string(),
        load_balancer_url: data["load_balancer_url"].as_str().map(String::from),
        ecr_repository_uri: data["ecr_repository_uri"].as_str().map(String::from),
        ecr_image_tag: data["ecr_image_tag"].as_str().map(String::from),
        cloudformation_stack_name: data["cloudformation_stack_name"].as_str().map(String::from),
        billing_status: serde_json::from_value(data["billing_status"].clone())
            .unwrap_or(ContainerBillingStatus::Active),
        total_billed: data["total_billed"].as_str().unwrap_or("0").to_string(),
        last_deployed_at: data["last_deployed_at"].as_str().map(String::from),
        last_health_check: data["last_health_check"].as_str().map(String::from),
        deployment_log: data["deployment_log"].as_str().map(String::from),
        error_message: data["error_message"].as_str().map(String::from),
        metadata: serde_json::from_value(data["metadata"].clone()).unwrap_or_default(),
        created_at: data["created_at"].as_str().unwrap_or_default().to_string(),
        updated_at: data["updated_at"].as_str().unwrap_or_default().to_string(),
    }
}

/// ElizaCloud container provisioning and lifecycle management.
pub struct CloudContainerService {
    tracked: HashMap<String, CloudContainer>,
    container_defaults: crate::cloud_types::ContainerDefaults,
}

impl CloudContainerService {
    pub fn new() -> Self {
        Self {
            tracked: HashMap::new(),
            container_defaults: CloudPluginConfig::default().container,
        }
    }

    /// Initialize by loading existing containers.
    pub async fn start(&mut self, client: &CloudApiClient) -> Result<()> {
        let containers = self.list_containers(client).await?;
        for c in &containers {
            self.tracked.insert(c.id.clone(), c.clone());
        }
        info!("[CloudContainer] Loaded {} existing container(s)", containers.len());
        Ok(())
    }

    pub async fn stop(&mut self) {
        self.tracked.clear();
    }

    // ─── CRUD ───────────────────────────────────────────────────────────────

    pub async fn create_container(
        &mut self,
        client: &CloudApiClient,
        request: &CreateContainerRequest,
    ) -> Result<CreateContainerResponse> {
        let defs = &self.container_defaults;
        let payload = serde_json::json!({
            "name": request.name,
            "project_name": request.project_name,
            "description": request.description,
            "port": request.port.unwrap_or(defs.default_port),
            "desired_count": request.desired_count.unwrap_or(1),
            "cpu": request.cpu.unwrap_or(defs.default_cpu),
            "memory": request.memory.unwrap_or(defs.default_memory),
            "environment_vars": request.environment_vars.as_ref().unwrap_or(&HashMap::new()),
            "health_check_path": request.health_check_path.as_deref().unwrap_or("/health"),
            "ecr_image_uri": request.ecr_image_uri,
            "architecture": request.architecture.unwrap_or(defs.default_architecture),
        });

        let resp = client.post("/containers", &payload).await?;
        let response: CreateContainerResponse =
            serde_json::from_value(resp).map_err(ElizaCloudError::Json)?;

        self.tracked.insert(response.data.id.clone(), response.data.clone());
        info!(
            "[CloudContainer] Created container \"{}\" (id={})",
            request.name, response.data.id
        );

        Ok(response)
    }

    pub async fn list_containers(
        &self,
        client: &CloudApiClient,
    ) -> Result<Vec<CloudContainer>> {
        let resp = client.get("/containers").await?;
        let data = resp.get("data").cloned().unwrap_or(serde_json::json!([]));
        let containers: Vec<CloudContainer> =
            serde_json::from_value(data).unwrap_or_default();
        Ok(containers)
    }

    pub async fn get_container(
        &mut self,
        client: &CloudApiClient,
        container_id: &str,
    ) -> Result<CloudContainer> {
        let resp = client.get(&format!("/containers/{}", container_id)).await?;
        let data = resp.get("data").cloned().unwrap_or_default();
        let container: CloudContainer =
            serde_json::from_value(data).map_err(ElizaCloudError::Json)?;
        self.tracked.insert(container_id.to_string(), container.clone());
        Ok(container)
    }

    pub async fn delete_container(
        &mut self,
        client: &CloudApiClient,
        container_id: &str,
    ) -> Result<()> {
        client.delete(&format!("/containers/{}", container_id)).await?;
        self.tracked.remove(container_id);
        info!("[CloudContainer] Deleted container {}", container_id);
        Ok(())
    }

    /// Wait for container deployment with exponential backoff.
    pub async fn wait_for_deployment(
        &mut self,
        client: &CloudApiClient,
        container_id: &str,
        timeout_secs: u64,
    ) -> Result<CloudContainer> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut interval_ms: u64 = 5000;
        let max_interval_ms: u64 = 30000;

        while std::time::Instant::now() < deadline {
            let container = self.get_container(client, container_id).await?;

            match container.status {
                ContainerStatus::Running => return Ok(container),
                ContainerStatus::Failed => {
                    let msg = container
                        .error_message
                        .as_deref()
                        .unwrap_or("unknown error");
                    return Err(ElizaCloudError::api(
                        500,
                        format!("Container deployment failed: {}", msg),
                    ));
                }
                ContainerStatus::Stopped | ContainerStatus::Suspended => {
                    return Err(ElizaCloudError::api(
                        500,
                        format!("Container reached terminal state: {}", container.status),
                    ));
                }
                _ => {}
            }

            tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
            interval_ms = (interval_ms * 3 / 2).min(max_interval_ms);
        }

        Err(ElizaCloudError::api(
            408,
            format!("Container deployment timed out after {}s", timeout_secs),
        ))
    }

    // ─── Accessors ─────────────────────────────────────────────────────────

    pub fn tracked_containers(&self) -> Vec<&CloudContainer> {
        self.tracked.values().collect()
    }

    pub fn tracked_container(&self, container_id: &str) -> Option<&CloudContainer> {
        self.tracked.get(container_id)
    }

    pub fn is_container_running(&self, container_id: &str) -> bool {
        self.tracked
            .get(container_id)
            .map(|c| c.status == ContainerStatus::Running)
            .unwrap_or(false)
    }

    pub fn container_url(&self, container_id: &str) -> Option<&str> {
        self.tracked
            .get(container_id)
            .and_then(|c| c.load_balancer_url.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_service() {
        let svc = CloudContainerService::new();
        assert!(svc.tracked_containers().is_empty());
        assert!(!svc.is_container_running("nonexistent"));
        assert!(svc.container_url("nonexistent").is_none());
    }

    #[test]
    fn test_parse_container_minimal() {
        let data = serde_json::json!({"id": "c-1", "name": "test"});
        let c = parse_container(&data);
        assert_eq!(c.id, "c-1");
        assert_eq!(c.name, "test");
        assert_eq!(c.status, ContainerStatus::Pending);
    }

    #[test]
    fn test_parse_container_full() {
        let data = serde_json::json!({
            "id": "c-2",
            "name": "agent",
            "project_name": "proj",
            "status": "running",
            "port": 8080,
            "load_balancer_url": "https://lb.example.com",
        });
        let c = parse_container(&data);
        assert_eq!(c.status, ContainerStatus::Running);
        assert_eq!(c.port, 8080);
        assert_eq!(c.load_balancer_url.as_deref(), Some("https://lb.example.com"));
    }
}
