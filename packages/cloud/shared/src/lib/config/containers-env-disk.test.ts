/**
 * Tests for the node disk clean manager env knobs in containers-env.ts.
 * `containersEnv` reads through `getCloudAwareEnv()`, which returns `process.env`
 * directly when no cloud ALS store is active (the case under bun test), so we
 * drive these by mutating + restoring the three NODE_DISK_* keys.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { containersEnv } from "./containers-env";

const KEYS = [
  "NODE_DISK_PRUNE_THRESHOLD_PCT",
  "NODE_DISK_UNHEALTHY_THRESHOLD_PCT",
  "NODE_DISK_PRUNE_COOLDOWN_MS",
  "NODE_DISK_AGENT_IMAGE_PRUNE_INTERVAL_MS",
  "NODE_DISK_AGENT_IMAGE_PRUNE_KEEP_NEWEST",
  "NODE_DISK_AGENT_IMAGE_PRUNE_MAX_AGE_HOURS",
] as const;

const saved = new Map<string, string | undefined>();
function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("nodeDiskPruneThresholdPct", () => {
  test("defaults to 80 when unset", () => {
    setEnv({});
    expect(containersEnv.nodeDiskPruneThresholdPct()).toBe(80);
  });

  test("reads a valid override", () => {
    setEnv({ NODE_DISK_PRUNE_THRESHOLD_PCT: "75" });
    expect(containersEnv.nodeDiskPruneThresholdPct()).toBe(75);
  });

  test("clamps to [50, 99]", () => {
    setEnv({ NODE_DISK_PRUNE_THRESHOLD_PCT: "10" });
    expect(containersEnv.nodeDiskPruneThresholdPct()).toBe(50);
    setEnv({ NODE_DISK_PRUNE_THRESHOLD_PCT: "200" });
    expect(containersEnv.nodeDiskPruneThresholdPct()).toBe(99);
  });
});

describe("nodeDiskUnhealthyThresholdPct", () => {
  test("defaults to 92 when unset", () => {
    setEnv({});
    expect(containersEnv.nodeDiskUnhealthyThresholdPct()).toBe(92);
  });

  test("stays strictly above the prune threshold even if configured lower", () => {
    // Prune at 88, unhealthy configured at 85 (below prune) → forced to 89.
    setEnv({
      NODE_DISK_PRUNE_THRESHOLD_PCT: "88",
      NODE_DISK_UNHEALTHY_THRESHOLD_PCT: "85",
    });
    expect(containersEnv.nodeDiskUnhealthyThresholdPct()).toBe(89);
  });
});

describe("nodeDiskPruneCooldownMs", () => {
  test("defaults to 30 minutes when unset", () => {
    setEnv({});
    expect(containersEnv.nodeDiskPruneCooldownMs()).toBe(30 * 60_000);
  });

  test("clamps to [60s, 6h]", () => {
    setEnv({ NODE_DISK_PRUNE_COOLDOWN_MS: "1000" });
    expect(containersEnv.nodeDiskPruneCooldownMs()).toBe(60_000);
    setEnv({ NODE_DISK_PRUNE_COOLDOWN_MS: String(99 * 60 * 60_000) });
    expect(containersEnv.nodeDiskPruneCooldownMs()).toBe(6 * 60 * 60_000);
  });
});

describe("nodeDiskAgentImagePruneIntervalMs", () => {
  test("defaults to 24 hours when unset", () => {
    setEnv({});
    expect(containersEnv.nodeDiskAgentImagePruneIntervalMs()).toBe(24 * 60 * 60_000);
  });

  test("clamps to [1h, 7d]", () => {
    setEnv({ NODE_DISK_AGENT_IMAGE_PRUNE_INTERVAL_MS: "1000" });
    expect(containersEnv.nodeDiskAgentImagePruneIntervalMs()).toBe(60 * 60_000);
    setEnv({ NODE_DISK_AGENT_IMAGE_PRUNE_INTERVAL_MS: String(30 * 24 * 60 * 60_000) });
    expect(containersEnv.nodeDiskAgentImagePruneIntervalMs()).toBe(7 * 24 * 60 * 60_000);
  });
});

describe("nodeDiskAgentImagePruneKeepNewest", () => {
  test("defaults to keeping the current image plus one rollback ref", () => {
    setEnv({});
    expect(containersEnv.nodeDiskAgentImagePruneKeepNewest()).toBe(2);
  });

  test("clamps to [1, 10]", () => {
    setEnv({ NODE_DISK_AGENT_IMAGE_PRUNE_KEEP_NEWEST: "0" });
    expect(containersEnv.nodeDiskAgentImagePruneKeepNewest()).toBe(1);
    setEnv({ NODE_DISK_AGENT_IMAGE_PRUNE_KEEP_NEWEST: "100" });
    expect(containersEnv.nodeDiskAgentImagePruneKeepNewest()).toBe(10);
  });
});

describe("nodeDiskAgentImagePruneMaxAgeHours", () => {
  test("defaults to 7 days when unset", () => {
    setEnv({});
    expect(containersEnv.nodeDiskAgentImagePruneMaxAgeHours()).toBe(7 * 24);
  });

  test("clamps to [24h, 90d]", () => {
    setEnv({ NODE_DISK_AGENT_IMAGE_PRUNE_MAX_AGE_HOURS: "1" });
    expect(containersEnv.nodeDiskAgentImagePruneMaxAgeHours()).toBe(24);
    setEnv({ NODE_DISK_AGENT_IMAGE_PRUNE_MAX_AGE_HOURS: String(365 * 24) });
    expect(containersEnv.nodeDiskAgentImagePruneMaxAgeHours()).toBe(90 * 24);
  });
});
