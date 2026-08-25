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

describe("embeddingSidecarHostPort", () => {
  const hostPortKeys = [
    "CONTAINERS_EMBEDDING_SIDECAR_HOST_PORT",
    "ELIZA_EMBEDDING_SIDECAR_HOST_PORT",
  ] as const;
  const savedHost = new Map<string, string | undefined>();
  function setHostPort(
    value: string | undefined,
    key: (typeof hostPortKeys)[number] = "CONTAINERS_EMBEDDING_SIDECAR_HOST_PORT",
  ): void {
    for (const k of hostPortKeys) {
      if (!savedHost.has(k)) savedHost.set(k, process.env[k]);
      delete process.env[k];
    }
    if (value !== undefined) process.env[key] = value;
  }
  afterEach(() => {
    for (const [k, v] of savedHost) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedHost.clear();
  });

  test("defaults to 8290 when unset", () => {
    setHostPort(undefined);
    expect(containersEnv.embeddingSidecarHostPort()).toBe(8290);
  });

  test("accepts canonical port", () => {
    setHostPort("8080");
    expect(containersEnv.embeddingSidecarHostPort()).toBe(8080);
    setHostPort("  9000  ");
    expect(containersEnv.embeddingSidecarHostPort()).toBe(9000);
  });

  test("rejects trailing junk, hex, floats and out-of-range", () => {
    for (const junk of [
      "8080abc",
      "0x10",
      "8080.5",
      "1e3",
      "010",
      "0",
      "70000",
      "-1",
      "Infinity",
      "",
    ]) {
      setHostPort(junk);
      expect(containersEnv.embeddingSidecarHostPort(), `junk ${junk}`).toBe(8290);
    }
  });

  test("falls back to legacy key when primary unset", () => {
    setHostPort("9090", "ELIZA_EMBEDDING_SIDECAR_HOST_PORT");
    expect(containersEnv.embeddingSidecarHostPort()).toBe(9090);
  });

  test("clamps to [1, 65535] even for canonical", () => {
    setHostPort("65535");
    expect(containersEnv.embeddingSidecarHostPort()).toBe(65535);
    setHostPort("65536");
    expect(containersEnv.embeddingSidecarHostPort()).toBe(8290);
    setHostPort("1");
    expect(containersEnv.embeddingSidecarHostPort()).toBe(1);
  });
});
