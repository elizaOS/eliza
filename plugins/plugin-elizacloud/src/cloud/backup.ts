/**
 * Periodic state backup scheduler for cloud sandboxes.
 * Default interval: 60s. Configurable via cloud.backup.autoBackupIntervalMs.
 */

import { logger } from "@elizaos/core";
import type { ElizaCloudClient } from "./bridge-client.js";

export class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private snapshotInFlight: Promise<void> | null = null;

  constructor(
    private client: ElizaCloudClient,
    private agentId: string,
    private intervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      if (this.snapshotInFlight) return;

      this.snapshot().catch((err) => {
        logger.warn(`[cloud-backup] Auto-backup failed: ${String(err)}`);
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async finalSnapshot(): Promise<void> {
    // A periodic snapshot may still be running when shutdown begins. Wait for
    // it to settle before taking the final snapshot.
    await this.snapshotInFlight?.catch(() => undefined);
    await this.snapshot().catch((err) => {
      logger.warn(`[cloud-backup] Final snapshot failed: ${String(err)}`);
    });
  }

  private snapshot(): Promise<void> {
    const snapshot = this.client.snapshot(this.agentId).then(() => undefined);
    this.snapshotInFlight = snapshot.finally(() => {
      this.snapshotInFlight = null;
    });
    return this.snapshotInFlight;
  }
}
