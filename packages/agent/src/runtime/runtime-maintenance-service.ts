/**
 * Runs idempotent data maintenance after SQL migrations and before the runtime
 * becomes ready. Keeping these short database jobs inside a Service lifecycle
 * prevents detached startup writes from racing runtime and adapter shutdown.
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { scheduleAttachmentKnowledgeBackfill } from "../api/attachment-knowledge-backfill.ts";
import { scheduleMediaGc } from "../api/media-runtime.ts";
import { migrateWorkbenchScheduleTags } from "../triggers/workbench-migration.ts";

export const RUNTIME_MAINTENANCE_SERVICE = "eliza_runtime_maintenance";

interface MaintenanceJob {
  scope: string;
  run: () => Promise<unknown>;
}

export class RuntimeMaintenanceService extends Service {
  static override serviceType = RUNTIME_MAINTENANCE_SERVICE;

  override capabilityDescription =
    "Lifecycle-owned startup migrations and one-time maintenance scheduling";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<RuntimeMaintenanceService> {
    const service = new RuntimeMaintenanceService(runtime);
    await service.runStartupMaintenance();
    return service;
  }

  private async runStartupMaintenance(): Promise<void> {
    const jobs: MaintenanceJob[] = [
      {
        scope: "workbench-schedule-tag-migration",
        run: () => migrateWorkbenchScheduleTags(this.runtime),
      },
      {
        scope: "knowledge-backfill-schedule",
        run: () => scheduleAttachmentKnowledgeBackfill(this.runtime),
      },
      {
        scope: "media-gc-schedule",
        run: () => scheduleMediaGc(this.runtime),
      },
    ];

    await Promise.all(
      jobs.map(async ({ scope, run }) => {
        try {
          await run();
        } catch (err) {
          // error-policy:J7 maintenance failure is agent-visible but does not
          // fabricate a successful migration or prevent the runtime from booting.
          this.runtime.reportError(scope, err, {
            phase: "startup-maintenance",
          });
          this.runtime.logger.warn(
            `[runtime-maintenance] ${scope} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
  }

  async stop(): Promise<void> {}
}
