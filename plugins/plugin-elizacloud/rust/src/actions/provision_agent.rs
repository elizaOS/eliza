//! PROVISION_CLOUD_AGENT — Deploy an elizaOS agent to ElizaCloud.

use std::collections::HashMap;

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{
    ActionResult, CloudPluginConfig, CreateContainerRequest,
    collect_env_vars,
};
use crate::error::Result;
use crate::services::{CloudBackupService, CloudBridgeService, CloudContainerService};

/// Action metadata.
pub const ACTION_NAME: &str = "PROVISION_CLOUD_AGENT";
pub const ACTION_DESCRIPTION: &str =
    "Deploy an elizaOS agent to ElizaCloud. Provisions a container, \
     waits for deployment, connects the bridge, and starts auto-backup.";

/// Extract params from options or metadata.
pub fn extract_params(options: &HashMap<String, serde_json::Value>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (key, val) in options {
        if let Some(s) = val.as_str() {
            result.insert(key.clone(), s.to_string());
        }
    }
    result
}

/// Handle the PROVISION_CLOUD_AGENT action.
pub async fn handle_provision_agent(
    client: &CloudApiClient,
    container_svc: &mut CloudContainerService,
    bridge_svc: Option<&mut CloudBridgeService>,
    backup_svc: Option<&mut CloudBackupService>,
    settings: &HashMap<String, String>,
    options: &HashMap<String, serde_json::Value>,
) -> Result<ActionResult> {
    let params = extract_params(options);

    let name = match params.get("name") {
        Some(n) if !n.is_empty() => n.clone(),
        _ => return Ok(ActionResult::err("Missing required parameter: name")),
    };

    let project_name = match params.get("project_name") {
        Some(p) if !p.is_empty() => p.clone(),
        _ => return Ok(ActionResult::err("Missing required parameter: project_name")),
    };

    let defs = CloudPluginConfig::default().container;
    let mut env_vars = collect_env_vars(settings);
    if let Some(extra) = options.get("environment_vars") {
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    env_vars.insert(k.clone(), s.to_string());
                }
            }
        }
    }

    let request = CreateContainerRequest {
        name: name.clone(),
        project_name: project_name.clone(),
        ecr_image_uri: defs.default_image.clone(),
        description: params.get("description").cloned(),
        port: Some(defs.default_port),
        cpu: Some(defs.default_cpu),
        memory: Some(defs.default_memory),
        architecture: Some(defs.default_architecture),
        environment_vars: Some(env_vars),
        health_check_path: Some("/health".to_string()),
        desired_count: None,
        ecr_repository_uri: None,
        image_tag: None,
    };

    let created = container_svc.create_container(client, &request).await?;
    let container_id = created.data.id.clone();

    let running = container_svc
        .wait_for_deployment(client, &container_id, 900)
        .await?;

    let mut bridge_connected = false;
    if let Some(bridge) = bridge_svc {
        bridge.connect(&container_id).await;
        bridge_connected = true;
    }

    let auto_backup = options
        .get("auto_backup")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if auto_backup {
        if let Some(backup) = backup_svc {
            backup.schedule_auto_backup(&container_id);
        }
    }

    Ok(ActionResult::ok(
        format!("Cloud agent \"{}\" deployed", name),
        serde_json::json!({
            "containerId": container_id,
            "containerUrl": running.load_balancer_url,
            "status": running.status,
            "creditsDeducted": created.credits_deducted,
            "creditsRemaining": created.credits_remaining,
            "bridgeConnected": bridge_connected,
            "autoBackupEnabled": auto_backup,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_params() {
        let mut opts = HashMap::new();
        opts.insert("name".to_string(), serde_json::json!("my-agent"));
        opts.insert("project_name".to_string(), serde_json::json!("proj"));

        let params = extract_params(&opts);
        assert_eq!(params.get("name"), Some(&"my-agent".to_string()));
        assert_eq!(params.get("project_name"), Some(&"proj".to_string()));
    }

    #[test]
    fn test_extract_params_ignores_non_string() {
        let mut opts = HashMap::new();
        opts.insert("count".to_string(), serde_json::json!(5));
        let params = extract_params(&opts);
        assert!(!params.contains_key("count"));
    }
}
