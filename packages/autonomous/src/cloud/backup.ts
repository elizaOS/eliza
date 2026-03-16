/**
 * Periodic state backup scheduler for cloud sandboxes.
 * Default interval: 60s. Configurable via cloud.backup.autoBackupIntervalMs.
 */

import { logger } from "@elizaos/core";
import type { ElizaCloudClient } from "./bridge-client";

export class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private client: ElizaCloudClient,
    private agentId: string,
    private intervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.client.snapshot(this.agentId).catch((err) => {
        logger.warn(
          `[cloud-backup] Auto-backup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
    await this.client.snapshot(this.agentId).catch((err) => {
      logger.warn(
        `[cloud-backup] Final snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
