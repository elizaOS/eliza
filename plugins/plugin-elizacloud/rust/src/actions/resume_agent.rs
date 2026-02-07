//! RESUME_CLOUD_AGENT — Restore a frozen agent from snapshot.

use std::collections::HashMap;

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{ActionResult, CloudPluginConfig, CreateContainerRequest, collect_env_vars};
use crate::error::Result;
use crate::services::{CloudBackupService, CloudBridgeService, CloudContainerService};

pub const ACTION_NAME: &str = "RESUME_CLOUD_AGENT";
pub const ACTION_DESCRIPTION: &str =
    "Resume a frozen cloud agent from snapshot. Re-provisions, restores state, reconnects bridge.";

/// Handle the RESUME_CLOUD_AGENT action.
pub async fn handle_resume_agent(
    client: &CloudApiClient,
    container_svc: &mut CloudContainerService,
    bridge_svc: Option<&mut CloudBridgeService>,
    backup_svc: Option<&mut CloudBackupService>,
    settings: &HashMap<String, String>,
    options: &HashMap<String, serde_json::Value>,
) -> Result<ActionResult> {
    let name = match options.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return Ok(ActionResult::err("Missing required parameter: name")),
    };

    let project_name = match options.get("project_name").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p.to_string(),
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
        description: None,
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

    // Restore from snapshot
    let mut restored_id: Option<String> = None;
    if let Some(backup) = backup_svc {
        let explicit = options.get("snapshotId").and_then(|v| v.as_str());
        if let Some(snap_id) = explicit {
            backup.restore_snapshot(client, &container_id, snap_id).await?;
            restored_id = Some(snap_id.to_string());
        } else {
            // Find latest snapshot for this project
            let all_containers = container_svc.list_containers(client).await?;
            let project_ids: Vec<String> = all_containers
                .iter()
                .filter(|c| c.project_name == project_name)
                .map(|c| c.id.clone())
                .collect();

            let mut all_snapshots = Vec::new();
            for pid in &project_ids {
                if let Ok(snaps) = backup.list_snapshots(client, pid).await {
                    all_snapshots.extend(snaps);
                }
            }
            all_snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));

            if let Some(latest) = all_snapshots.first() {
                backup
                    .restore_snapshot(client, &container_id, &latest.id)
                    .await?;
                restored_id = Some(latest.id.clone());
            }
        }
        backup.schedule_auto_backup(&container_id);
    }

    if let Some(bridge) = bridge_svc {
        bridge.connect(&container_id).await;
    }

    Ok(ActionResult::ok(
        format!("Cloud agent \"{}\" resumed", name),
        serde_json::json!({
            "containerId": container_id,
            "containerUrl": running.load_balancer_url,
            "restoredSnapshotId": restored_id,
            "creditsDeducted": created.credits_deducted,
            "creditsRemaining": created.credits_remaining,
        }),
    ))
}
