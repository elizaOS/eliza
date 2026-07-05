/**
 * Locks the schedule-observation identity scheme. `observationId` derives the
 * persisted primary key that `repository.upsertScheduleObservation`'s
 * ON CONFLICT(id) collapses duplicates on, so the derivation must be
 * deterministic (same tuple -> same id, for dedup) and use a strong,
 * non-weak-crypto digest (SHA-256) — CodeQL js/weak-cryptographic-algorithm
 * flags SHA-1 here even though the use is content-addressing, not signing.
 * The golden recompute below fails if the code ever reverts to SHA-1.
 */
import crypto from "node:crypto";
import type { SyncLifeOpsScheduleObservationsRequest } from "@elizaos/plugin-elizacloud/cloud/lifeops-schedule-sync-contracts";
import { describe, expect, it } from "vitest";
import { recordsFromSyncRequest } from "./schedule-state";

const AGENT_ID = "agent-schedule-id-test";

// UTC, 30-min-aligned so window bucketing is a no-op and the input flows
// straight into the id tuple; keeps the golden recompute inputs unambiguous.
const baseRequest = (
  overrides: Partial<SyncLifeOpsScheduleObservationsRequest> = {},
): SyncLifeOpsScheduleObservationsRequest => ({
  deviceId: "device-alpha",
  deviceKind: "mac",
  timezone: "UTC",
  observedAt: "2026-01-01T10:05:00.000Z",
  observations: [
    {
      circadianState: "awake",
      stateConfidence: 0.9,
      windowStartAt: "2026-01-01T10:00:00.000Z",
    },
  ],
  ...overrides,
});

// Independent reimplementation of the id derivation, keyed off the returned
// record's own fields, so it verifies the algorithm without coupling to the
// internal bucketing that produces windowStartAt.
function expectedId(
  observation: {
    agentId: string;
    origin: string;
    deviceId: string;
    circadianState: string;
    windowStartAt: string;
    mealLabel: string | null;
  },
  hash: "sha256" | "sha1",
): string {
  const digest = crypto
    .createHash(hash)
    .update(
      [
        observation.agentId,
        observation.origin,
        observation.deviceId,
        observation.circadianState,
        observation.windowStartAt,
        observation.mealLabel ?? "",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  return `lifeops-schedule-observation:${digest}`;
}

describe("schedule observation id derivation", () => {
  it("produces a prefixed 16-hex-char content-addressed id", () => {
    const [observation] = recordsFromSyncRequest({
      agentId: AGENT_ID,
      origin: "device_sync",
      request: baseRequest(),
    });
    expect(observation).toBeDefined();
    expect(observation.id).toMatch(
      /^lifeops-schedule-observation:[0-9a-f]{16}$/,
    );
  });

  it("is deterministic so identical observations dedup to one row", () => {
    const first = recordsFromSyncRequest({
      agentId: AGENT_ID,
      origin: "device_sync",
      request: baseRequest(),
    })[0];
    const second = recordsFromSyncRequest({
      agentId: AGENT_ID,
      origin: "device_sync",
      request: baseRequest(),
    })[0];
    expect(second.id).toBe(first.id);
  });

  it("distinguishes observations that differ in a tuple field", () => {
    const alpha = recordsFromSyncRequest({
      agentId: AGENT_ID,
      origin: "device_sync",
      request: baseRequest(),
    })[0];
    const beta = recordsFromSyncRequest({
      agentId: AGENT_ID,
      origin: "device_sync",
      request: baseRequest({ deviceId: "device-beta" }),
    })[0];
    expect(beta.id).not.toBe(alpha.id);
  });

  it("derives the id with SHA-256, not the weak SHA-1 (CodeQL #649)", () => {
    const [observation] = recordsFromSyncRequest({
      agentId: AGENT_ID,
      origin: "device_sync",
      request: baseRequest(),
    });
    expect(observation.id).toBe(expectedId(observation, "sha256"));
    expect(observation.id).not.toBe(expectedId(observation, "sha1"));
  });
});
