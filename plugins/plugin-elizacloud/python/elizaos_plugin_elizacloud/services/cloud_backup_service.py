"""
CloudBackupService — Agent state snapshots and restore.

Creates, lists, and restores agent state snapshots through the ElizaCloud
API. Supports manual snapshots, periodic auto-backup, and pre-eviction
snapshots triggered by the billing system's low-credit warning.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.types.cloud import (
    AgentSnapshot,
    DEFAULT_CLOUD_CONFIG,
    SnapshotType,
)

logger = logging.getLogger("elizacloud.backup")


def _format_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    if num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    return f"{num_bytes / (1024 * 1024 * 1024):.1f} GB"


def _parse_snapshot(data: dict[str, object]) -> AgentSnapshot:
    return AgentSnapshot(
        id=str(data.get("id", "")),
        container_id=str(data.get("containerId", "")),
        organization_id=str(data.get("organizationId", "")),
        snapshot_type=str(data.get("snapshotType", "manual")),  # type: ignore[arg-type]
        storage_url=str(data.get("storageUrl", "")),
        size_bytes=int(data.get("sizeBytes", 0)),  # type: ignore[arg-type]
        agent_config=dict(data.get("agentConfig", {})),  # type: ignore[arg-type]
        metadata=dict(data.get("metadata", {})),  # type: ignore[arg-type]
        created_at=str(data.get("created_at", "")),
    )


@dataclass
class _AutoBackupEntry:
    container_id: str
    task: asyncio.Task[None] | None
    last_backup_at: float | None


class CloudBackupService:
    """ElizaCloud agent state backup and restore."""

    service_type = "CLOUD_BACKUP"

    def __init__(self) -> None:
        self._auth_service: CloudAuthService | None = None
        self._auto_backups: dict[str, _AutoBackupEntry] = {}
        self._max_snapshots = DEFAULT_CLOUD_CONFIG.backup.max_snapshots
        self._backup_interval_ms = DEFAULT_CLOUD_CONFIG.backup.auto_backup_interval_ms

    async def start(self, auth_service: CloudAuthService) -> None:
        self._auth_service = auth_service
        logger.info("[CloudBackup] Service initialized")

    async def stop(self) -> None:
        for entry in self._auto_backups.values():
            if entry.task and not entry.task.done():
                entry.task.cancel()
        self._auto_backups.clear()
        logger.info("[CloudBackup] Service stopped")

    def _get_client(self):  # noqa: ANN202
        if not self._auth_service:
            raise RuntimeError("CloudBackupService not initialized")
        return self._auth_service.get_client()

    # ─── Snapshot CRUD ─────────────────────────────────────────────────────

    async def create_snapshot(
        self,
        container_id: str,
        snapshot_type: SnapshotType = "manual",
        metadata: dict[str, object] | None = None,
    ) -> AgentSnapshot:
        client = self._get_client()
        resp = await client.post(
            f"/agent-state/{container_id}/snapshot",
            {"snapshotType": snapshot_type, "metadata": metadata or {}},
        )
        raw_data = resp.get("data", {})
        if not isinstance(raw_data, dict):
            raw_data = {}
        snapshot = _parse_snapshot(raw_data)

        logger.info(
            "[CloudBackup] Created %s snapshot for container %s (id=%s, size=%s)",
            snapshot_type,
            container_id,
            snapshot.id,
            _format_bytes(snapshot.size_bytes),
        )

        entry = self._auto_backups.get(container_id)
        if entry:
            entry.last_backup_at = time.time()

        return snapshot

    async def list_snapshots(self, container_id: str) -> list[AgentSnapshot]:
        client = self._get_client()
        resp = await client.get(f"/agent-state/{container_id}/snapshots")
        raw_list = resp.get("data", [])
        if not isinstance(raw_list, list):
            raw_list = []
        return [_parse_snapshot(s) for s in raw_list if isinstance(s, dict)]

    async def restore_snapshot(self, container_id: str, snapshot_id: str) -> None:
        client = self._get_client()
        await client.post(
            f"/agent-state/{container_id}/restore",
            {"snapshotId": snapshot_id},
        )
        logger.info(
            "[CloudBackup] Restored snapshot %s for container %s",
            snapshot_id,
            container_id,
        )

    async def get_latest_snapshot(self, container_id: str) -> AgentSnapshot | None:
        snapshots = await self.list_snapshots(container_id)
        if not snapshots:
            return None
        snapshots.sort(key=lambda s: s.created_at, reverse=True)
        return snapshots[0]

    # ─── Auto-Backup Scheduling ────────────────────────────────────────────

    def schedule_auto_backup(
        self,
        container_id: str,
        interval_ms: int | None = None,
    ) -> None:
        if container_id in self._auto_backups:
            logger.debug("[CloudBackup] Auto-backup already scheduled for %s", container_id)
            return

        interval = interval_ms or self._backup_interval_ms
        interval_s = interval / 1000.0

        async def _run_auto_backup() -> None:
            while True:
                await asyncio.sleep(interval_s)
                try:
                    logger.debug("[CloudBackup] Running auto-backup for %s", container_id)
                    await self.create_snapshot(container_id, "auto", {
                        "trigger": "scheduled",
                        "scheduledIntervalMs": interval,
                    })
                    await self._prune_snapshots(container_id)
                except Exception as exc:
                    logger.error(
                        "[CloudBackup] Auto-backup failed for %s: %s",
                        container_id,
                        exc,
                    )

        task = asyncio.ensure_future(_run_auto_backup())
        self._auto_backups[container_id] = _AutoBackupEntry(
            container_id=container_id,
            task=task,
            last_backup_at=None,
        )
        logger.info(
            "[CloudBackup] Scheduled auto-backup for %s every %d minutes",
            container_id,
            round(interval / 60_000),
        )

    def cancel_auto_backup(self, container_id: str) -> None:
        entry = self._auto_backups.pop(container_id, None)
        if not entry:
            return
        if entry.task and not entry.task.done():
            entry.task.cancel()
        logger.info("[CloudBackup] Cancelled auto-backup for %s", container_id)

    async def create_pre_eviction_snapshot(self, container_id: str) -> AgentSnapshot:
        """Create a pre-eviction snapshot before billing shutdown."""
        logger.info("[CloudBackup] Creating pre-eviction snapshot for %s", container_id)
        return await self.create_snapshot(container_id, "pre-eviction", {
            "trigger": "billing-eviction",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

    # ─── Snapshot Pruning ──────────────────────────────────────────────────

    async def _prune_snapshots(self, container_id: str) -> None:
        """Remove the oldest auto snapshots beyond max_snapshots limit."""
        snapshots = await self.list_snapshots(container_id)
        auto_snapshots = sorted(
            [s for s in snapshots if s.snapshot_type == "auto"],
            key=lambda s: s.created_at,
            reverse=True,
        )

        excess = auto_snapshots[self._max_snapshots:]
        if not excess:
            return

        client = self._get_client()
        for snap in excess:
            await client.delete(f"/agent-state/{container_id}/snapshots/{snap.id}")
            logger.debug("[CloudBackup] Pruned old auto snapshot %s", snap.id)

        logger.info(
            "[CloudBackup] Pruned %d old auto snapshot(s) for %s",
            len(excess),
            container_id,
        )

    # ─── Accessors ─────────────────────────────────────────────────────────

    def is_auto_backup_scheduled(self, container_id: str) -> bool:
        return container_id in self._auto_backups

    def get_last_backup_time(self, container_id: str) -> float | None:
        entry = self._auto_backups.get(container_id)
        return entry.last_backup_at if entry else None
