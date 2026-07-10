/** Verifies an unconfigured health connector produces an explicit disconnected status without requiring a persisted grant. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import { HealthDomain } from "./health-service.js";

const HEALTH_ENV_KEYS = [
  "ELIZA_STRAVA_CLIENT_ID",
  "ELIZA_STRAVA_CLIENT_SECRET",
] as const;

describe("HealthDomain connector status", () => {
  afterEach(() => {
    for (const key of HEALTH_ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("reports config_missing when no connector grant or OAuth config exists", async () => {
    for (const key of HEALTH_ENV_KEYS) {
      delete process.env[key];
    }
    const repository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
    };
    const domain = new HealthDomain({
      repository,
      agentId: () => "00000000-0000-0000-0000-0000000000aa",
    } as unknown as LifeOpsContext);

    const status = await domain.getHealthDataConnectorStatus(
      "strava",
      new URL("http://127.0.0.1:2138"),
    );

    expect(status).toMatchObject({
      provider: "strava",
      side: "owner",
      mode: "local",
      executionTarget: "local",
      sourceOfTruth: "local_storage",
      configured: false,
      connected: false,
      reason: "config_missing",
      identity: null,
      grantedScopes: [],
      grant: null,
    });
    expect(repository.getHealthSyncState).not.toHaveBeenCalled();
  });
});
