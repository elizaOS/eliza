/**
 * Sleep-episode persistence types and helpers used by `sleep-episode-store.ts`.
 *
 * `LifeOpsSleepEpisodeRecord` and `createLifeOpsSleepEpisode` originally lived
 * in `app-lifeops/src/lifeops/repository.ts`. plugin-health needs the type
 * (for typed access) and the factory (for record construction) without
 * pulling in the entire LifeOps repository / SQL layer. The record shape is
 * unchanged; the factory is reproduced byte-identically.
 *
 * The `SleepEpisodeRepository` interface narrows `LifeOpsRepository` to the
 * two methods `sleep-episode-store.ts` calls. app-lifeops' `LifeOpsRepository`
 * is structurally compatible with this interface, so no adapter is needed at
 * the call site.
 */

import crypto from "node:crypto";
import type {
  LifeOpsSleepCycleEvidence,
  LifeOpsSleepCycleType,
} from "../contracts/health.js";

export type LifeOpsPersistedSleepEpisodeSource =
  | LifeOpsSleepCycleEvidence["source"]
  | "manual";

export interface LifeOpsSleepEpisodeRecord {
  id: string;
  agentId: string;
  startAt: string;
  endAt: string | null;
  source: LifeOpsPersistedSleepEpisodeSource;
  confidence: number;
  cycleType: LifeOpsSleepCycleType;
  sealed: boolean;
  evidence: LifeOpsSleepCycleEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface SleepEpisodeRepository {
  upsertSleepEpisode(episode: LifeOpsSleepEpisodeRecord): Promise<void>;
  listSleepEpisodesBetween(
    agentId: string,
    startAt: string,
    endAt: string,
    opts?: { includeOpen?: boolean; limit?: number },
  ): Promise<LifeOpsSleepEpisodeRecord[]>;
}

export function createLifeOpsSleepEpisode(
  params: Omit<LifeOpsSleepEpisodeRecord, "id" | "createdAt" | "updatedAt">,
): LifeOpsSleepEpisodeRecord {
  const timestamp = new Date().toISOString();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
