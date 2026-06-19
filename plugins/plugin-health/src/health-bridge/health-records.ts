/**
 * Health-record factories — small pure helpers that build typed
 * `LifeOpsHealth*` records with stable id + timestamp fields.
 *
 * Originally lived in `app-lifeops/src/lifeops/repository.ts`; moved into
 * plugin-health in Wave-1 (W1-B). app-lifeops re-exports them from the
 * repository module for backward compatibility.
 */

import crypto from "node:crypto";
import type {
  LifeOpsHealthMetricSample,
  LifeOpsHealthSleepEpisode,
  LifeOpsHealthSyncState,
  LifeOpsHealthWorkout,
} from "../contracts/health.js";

function isoNow(): string {
  return new Date().toISOString();
}

export function createLifeOpsHealthMetricSample(
  params: Omit<LifeOpsHealthMetricSample, "id" | "createdAt" | "updatedAt">,
): LifeOpsHealthMetricSample {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsHealthWorkout(
  params: Omit<LifeOpsHealthWorkout, "id" | "createdAt" | "updatedAt">,
): LifeOpsHealthWorkout {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsHealthSleepEpisode(
  params: Omit<LifeOpsHealthSleepEpisode, "id" | "createdAt" | "updatedAt">,
): LifeOpsHealthSleepEpisode {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsHealthSyncState(
  params: Omit<LifeOpsHealthSyncState, "id" | "updatedAt">,
): LifeOpsHealthSyncState {
  return {
    ...params,
    id: crypto.randomUUID(),
    updatedAt: isoNow(),
  };
}
