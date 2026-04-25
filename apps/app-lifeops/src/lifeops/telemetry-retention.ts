/**
 * Retention + daily rollup runner for the canonical telemetry store. Called
 * from the scheduler tick (see `service-mixin-reminders.ts`) at most once
 * per UTC day per runtime process.
 *
 * The live write path goes through `LifeOpsRepository.createActivitySignal`
 * (which co-writes to `life_telemetry_events`). There is no longer any
 * backfill migrator because all supported deployments start from an empty
 * telemetry store — the legacy `migrateActivitySignalsToTelemetry` helper
 * was deleted during the cleanup pass.
 */

import type { LifeOpsRepository } from "./repository.js";

export const DEFAULT_TELEMETRY_RETENTION_DAYS = 60;

export async function runTelemetryRetention(args: {
  repository: LifeOpsRepository;
  agentId: string;
  retentionDays?: number;
}): Promise<{ deletedCount: number }> {
  const retentionDays = args.retentionDays ?? DEFAULT_TELEMETRY_RETENTION_DAYS;
  return args.repository.pruneTelemetryEvents({
    agentId: args.agentId,
    retentionDays,
  });
}
