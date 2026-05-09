/**
 * CloudBackupService — Agent state snapshots and restore.
 *
 * Creates, lists, and restores agent state snapshots through the ElizaCloud
 * API. Supports manual snapshots, periodic auto-backup, and pre-eviction
 * snapshots triggered by the billing system's low-credit warning.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  AgentSnapshot,
  CreateSnapshotResponse,
  RestoreSnapshotResponse,
  SnapshotListResponse,
  SnapshotType,
} from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import type { CloudAuthService } from "./cloud-auth";

interface AutoBackupEntry {
  containerId: string;
  timer: ReturnType<typeof setInterval>;
  lastBackupAt: number | null;
}

export class CloudBackupService extends Service {
  static serviceType = "CLOUD_BACKUP";
  capabilityDescription = "ElizaCloud agent state backup and restore";

  private authService!: CloudAuthService;
  private autoBackups: Map<string, AutoBackupEntry> = new Map();
  private readonly maxSnapshots = DEFAULT_CLOUD_CONFIG.backup.maxSnapshots;
  private readonly backupIntervalMs = DEFAULT_CLOUD_CONFIG.backup.autoBackupIntervalMs;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudBackupService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    for (const [, entry] of this.autoBackups) {
      clearInterval(entry.timer);
    }
    this.autoBackups.clear();
    logger.info("[CloudBackup] Service stopped");
  }

  private async initialize(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH");
    if (!auth) {
      logger.debug("[CloudBackup] CloudAuthService not available");
      return;
    }
    this.authService = auth as CloudAuthService;
    logger.info("[CloudBackup] Service initialized");
  }

  // ─── Snapshot CRUD ─────────────────────────────────────────────────────

  async createSnapshot(
    containerId: string,
    snapshotType: SnapshotType = "manual",
    metadata?: Record<string, unknown>
  ): Promise<AgentSnapshot> {
    const client = this.authService.getClient();
    const response = await client.post<CreateSnapshotResponse>(
      `/agent-state/${containerId}/snapshot`,
      { snapshotType, metadata }
    );

    logger.info(
      `[CloudBackup] Created ${snapshotType} snapshot for container ${containerId} (id=${response.data.id}, size=${formatBytes(response.data.sizeBytes)})`
    );

    // Update last backup timestamp for auto-backup tracking
    const autoEntry = this.autoBackups.get(containerId);
    if (autoEntry) {
      autoEntry.lastBackupAt = Date.now();
    }

    return response.data;
  }

  async listSnapshots(containerId: string): Promise<AgentSnapshot[]> {
    const client = this.authService.getClient();
    const response = await client.get<SnapshotListResponse>(
      `/agent-state/${containerId}/snapshots`
    );
    return response.data;
  }

  async restoreSnapshot(containerId: string, snapshotId: string): Promise<void> {
    const client = this.authService.getClient();

    await client.post<RestoreSnapshotResponse>(`/agent-state/${containerId}/restore`, {
      snapshotId,
    });

    logger.info(`[CloudBackup] Restored snapshot ${snapshotId} for container ${containerId}`);
  }

  async getLatestSnapshot(containerId: string): Promise<AgentSnapshot | null> {
    const snapshots = await this.listSnapshots(containerId);
    if (snapshots.length === 0) return null;

    // Sort by created_at descending and return the most recent
    snapshots.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return snapshots[0];
  }

  // ─── Auto-Backup Scheduling ────────────────────────────────────────────

  scheduleAutoBackup(containerId: string, intervalMs?: number): void {
    // Don't double-schedule
    if (this.autoBackups.has(containerId)) {
      logger.debug(`[CloudBackup] Auto-backup already scheduled for ${containerId}`);
      return;
    }

    const interval = intervalMs ?? this.backupIntervalMs;

    const timer = setInterval(() => {
      logger.debug(`[CloudBackup] Running auto-backup for container ${containerId}`);
      this.createSnapshot(containerId, "auto", {
        trigger: "scheduled",
        scheduledIntervalMs: interval,
      })
        .then(() => this.pruneSnapshots(containerId))
        .catch((err: Error) => {
          logger.error(`[CloudBackup] Auto-backup failed for ${containerId}: ${err.message}`);
        });
    }, interval);

    this.autoBackups.set(containerId, {
      containerId,
      timer,
      lastBackupAt: null,
    });

    logger.info(
      `[CloudBackup] Scheduled auto-backup for ${containerId} every ${Math.round(interval / 60_000)} minutes`
    );
  }

  cancelAutoBackup(containerId: string): void {
    const entry = this.autoBackups.get(containerId);
    if (!entry) return;

    clearInterval(entry.timer);
    this.autoBackups.delete(containerId);
    logger.info(`[CloudBackup] Cancelled auto-backup for ${containerId}`);
  }

  /**
   * Create a pre-eviction snapshot. Called when the billing system sends
   * a low-credit warning before shutting down the container.
   */
  async createPreEvictionSnapshot(containerId: string): Promise<AgentSnapshot> {
    logger.info(`[CloudBackup] Creating pre-eviction snapshot for ${containerId}`);
    return this.createSnapshot(containerId, "pre-eviction", {
      trigger: "billing-eviction",
      createdAt: new Date().toISOString(),
    });
  }

  // ─── Snapshot Pruning ──────────────────────────────────────────────────

  /**
   * Remove the oldest auto snapshots beyond maxSnapshots limit.
   * Manual and pre-eviction snapshots are never pruned.
   */
  private async pruneSnapshots(containerId: string): Promise<void> {
    const snapshots = await this.listSnapshots(containerId);

    const autoSnapshots = snapshots
      .filter((s) => s.snapshotType === "auto")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const excess = autoSnapshots.slice(this.maxSnapshots);
    if (excess.length === 0) return;

    const client = this.authService.getClient();
    for (const snapshot of excess) {
      await client.delete(`/agent-state/${containerId}/snapshots/${snapshot.id}`);
      logger.debug(`[CloudBackup] Pruned old auto snapshot ${snapshot.id} for ${containerId}`);
    }

    logger.info(`[CloudBackup] Pruned ${excess.length} old auto snapshot(s) for ${containerId}`);
  }

  // ─── Accessors ─────────────────────────────────────────────────────────

  isAutoBackupScheduled(containerId: string): boolean {
    return this.autoBackups.has(containerId);
  }

  getLastBackupTime(containerId: string): number | null {
    return this.autoBackups.get(containerId)?.lastBackupAt ?? null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
