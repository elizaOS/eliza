//! FREEZE_CLOUD_AGENT — Snapshot and stop a cloud agent.

use std::collections::HashMap;

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{ActionResult, ContainerStatus, SnapshotType};
use crate::error::Result;
use crate::services::{CloudBackupService, CloudBridgeService, CloudContainerService};

pub const ACTION_NAME: &str = "FREEZE_CLOUD_AGENT";
pub const ACTION_DESCRIPTION: &str =
    "Freeze a cloud agent: snapshot state, disconnect bridge, stop container.";

/// Handle the FREEZE_CLOUD_AGENT action.
pub async fn handle_freeze_agent(
    client: &CloudApiClient,
    container_svc: &mut CloudContainerService,
    bridge_svc: Option<&mut CloudBridgeService>,
    backup_svc: Option<&mut CloudBackupService>,
    options: &HashMap<String, serde_json::Value>,
) -> Result<ActionResult> {
    let container_id = match options.get("containerId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Ok(ActionResult::err("Missing containerId")),
    };

    let container = container_svc.get_container(client, &container_id).await?;
    if container.status != ContainerStatus::Running {
        return Ok(ActionResult::err(format!(
            "Container not running (status: {})",
            container.status
        )));
    }

    // Snapshot → disconnect → stop
    let mut snapshot_id: Option<String> = None;
    if let Some(backup) = backup_svc {
        let mut metadata = HashMap::new();
        metadata.insert(
            "trigger".to_string(),
            serde_json::json!("user-freeze"),
        );
        metadata.insert(
            "containerName".to_string(),
            serde_json::json!(container.name),
        );

        let snap = backup
            .create_snapshot(client, &container_id, SnapshotType::Manual, Some(metadata))
            .await?;
        snapshot_id = Some(snap.id);
        backup.cancel_auto_backup(&container_id);
    }

    if let Some(bridge) = bridge_svc {
        bridge.disconnect(&container_id).await;
    }

    container_svc.delete_container(client, &container_id).await?;

    Ok(ActionResult::ok(
        format!("Agent \"{}\" frozen", container.name),
        serde_json::json!({
            "containerId": container_id,
            "containerName": container.name,
            "snapshotId": snapshot_id,
        }),
    ))
}
