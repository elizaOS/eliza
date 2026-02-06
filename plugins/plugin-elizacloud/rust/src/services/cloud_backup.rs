//! CloudBackupService — Agent state snapshots and restore.

use std::collections::HashMap;
use tracing::{debug, info};

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{AgentSnapshot, CloudPluginConfig, SnapshotType};
use crate::error::Result;

/// Parse a snapshot from JSON.
pub fn parse_snapshot(data: &serde_json::Value) -> AgentSnapshot {
    AgentSnapshot {
        id: data["id"].as_str().unwrap_or_default().to_string(),
        container_id: data["containerId"].as_str().unwrap_or_default().to_string(),
        organization_id: data["organizationId"].as_str().unwrap_or_default().to_string(),
        snapshot_type: serde_json::from_value(data["snapshotType"].clone())
            .unwrap_or(SnapshotType::Manual),
        storage_url: data["storageUrl"].as_str().unwrap_or_default().to_string(),
        size_bytes: data["sizeBytes"].as_u64().unwrap_or(0),
        agent_config: serde_json::from_value(data["agentConfig"].clone()).unwrap_or_default(),
        metadata: serde_json::from_value(data["metadata"].clone()).unwrap_or_default(),
        created_at: data["created_at"].as_str().unwrap_or_default().to_string(),
    }
}

/// Format bytes into human-readable string.
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    if bytes < 1024 * 1024 * 1024 {
        return format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0));
    }
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

/// ElizaCloud agent state backup and restore.
pub struct CloudBackupService {
    auto_backups: HashMap<String, bool>,
    /// Maximum number of auto snapshots to keep per container.
    pub max_snapshots: u32,
}

impl CloudBackupService {
    pub fn new() -> Self {
        let config = CloudPluginConfig::default();
        Self {
            auto_backups: HashMap::new(),
            max_snapshots: config.backup.max_snapshots,
        }
    }

    pub async fn start(&mut self) {
        info!("[CloudBackup] Service initialized");
    }

    pub async fn stop(&mut self) {
        self.auto_backups.clear();
        info!("[CloudBackup] Service stopped");
    }

    // ─── Snapshot CRUD ─────────────────────────────────────────────────────

    pub async fn create_snapshot(
        &self,
        client: &CloudApiClient,
        container_id: &str,
        snapshot_type: SnapshotType,
        metadata: Option<HashMap<String, serde_json::Value>>,
    ) -> Result<AgentSnapshot> {
        let body = serde_json::json!({
            "snapshotType": snapshot_type,
            "metadata": metadata.unwrap_or_default(),
        });

        let resp = client
            .post(&format!("/agent-state/{}/snapshot", container_id), &body)
            .await?;

        let data = resp.get("data").cloned().unwrap_or_default();
        let snapshot = parse_snapshot(&data);

        info!(
            "[CloudBackup] Created {:?} snapshot for container {} (id={}, size={})",
            snapshot_type,
            container_id,
            snapshot.id,
            format_bytes(snapshot.size_bytes)
        );

        Ok(snapshot)
    }

    pub async fn list_snapshots(
        &self,
        client: &CloudApiClient,
        container_id: &str,
    ) -> Result<Vec<AgentSnapshot>> {
        let resp = client
            .get(&format!("/agent-state/{}/snapshots", container_id))
            .await?;

        let data = resp.get("data").cloned().unwrap_or(serde_json::json!([]));
        let snapshots: Vec<AgentSnapshot> =
            serde_json::from_value(data).unwrap_or_default();
        Ok(snapshots)
    }

    pub async fn restore_snapshot(
        &self,
        client: &CloudApiClient,
        container_id: &str,
        snapshot_id: &str,
    ) -> Result<()> {
        let body = serde_json::json!({"snapshotId": snapshot_id});
        client
            .post(&format!("/agent-state/{}/restore", container_id), &body)
            .await?;

        info!(
            "[CloudBackup] Restored snapshot {} for container {}",
            snapshot_id, container_id
        );
        Ok(())
    }

    pub async fn get_latest_snapshot(
        &self,
        client: &CloudApiClient,
        container_id: &str,
    ) -> Result<Option<AgentSnapshot>> {
        let mut snapshots = self.list_snapshots(client, container_id).await?;
        if snapshots.is_empty() {
            return Ok(None);
        }
        snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(Some(snapshots.remove(0)))
    }

    // ─── Auto-Backup Scheduling ────────────────────────────────────────────

    pub fn schedule_auto_backup(&mut self, container_id: &str) {
        if self.auto_backups.contains_key(container_id) {
            debug!("[CloudBackup] Auto-backup already scheduled for {}", container_id);
            return;
        }
        self.auto_backups.insert(container_id.to_string(), true);
        info!("[CloudBackup] Scheduled auto-backup for {}", container_id);
    }

    pub fn cancel_auto_backup(&mut self, container_id: &str) {
        if self.auto_backups.remove(container_id).is_some() {
            info!("[CloudBackup] Cancelled auto-backup for {}", container_id);
        }
    }

    pub fn is_auto_backup_scheduled(&self, container_id: &str) -> bool {
        self.auto_backups.contains_key(container_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(500), "500 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1048576), "1.0 MB");
        assert_eq!(format_bytes(1073741824), "1.0 GB");
    }

    #[test]
    fn test_parse_snapshot() {
        let data = serde_json::json!({
            "id": "s-1",
            "containerId": "c-1",
            "snapshotType": "auto",
            "sizeBytes": 1024,
            "created_at": "2025-01-01",
        });
        let snap = parse_snapshot(&data);
        assert_eq!(snap.id, "s-1");
        assert_eq!(snap.container_id, "c-1");
        assert_eq!(snap.snapshot_type, SnapshotType::Auto);
    }

    #[test]
    fn test_auto_backup_scheduling() {
        let mut svc = CloudBackupService::new();
        assert!(!svc.is_auto_backup_scheduled("c-1"));

        svc.schedule_auto_backup("c-1");
        assert!(svc.is_auto_backup_scheduled("c-1"));

        svc.cancel_auto_backup("c-1");
        assert!(!svc.is_auto_backup_scheduled("c-1"));
    }
}
