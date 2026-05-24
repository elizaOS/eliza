import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  checkProvisioningWorkerHealth,
  PROVISIONING_WORKER_HEARTBEAT_KEY,
  publishProvisioningWorkerHeartbeat,
} from "./provisioning-worker-health";

const TEST_ENV = {
  NODE_ENV: "production",
  REQUIRE_PROVISIONING_WORKER: "true",
  MOCK_REDIS: "1",
};

async function withEnv<T>(extra: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return runWithCloudBindingsAsync({ ...TEST_ENV, ...extra }, fn);
}

describe("provisioning worker health (Redis heartbeat)", () => {
  // These tests drive env via runWithCloudBindingsAsync (ALS), so process.env
  // must start clean — but we snapshot and restore rather than delete outright,
  // otherwise NODE_ENV=test leaks away and pollutes later files in the shared
  // `bun test` process (e.g. crypto.test.ts resolving the steward KMS backend).
  const MANAGED_ENV_KEYS = ["NODE_ENV", "REQUIRE_PROVISIONING_WORKER", "MOCK_REDIS"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  const clearManagedEnv = () => {
    for (const key of MANAGED_ENV_KEYS) {
      delete process.env[key];
    }
  };

  beforeEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    clearManagedEnv();
  });

  afterEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns unhealthy when no heartbeat has been published", async () => {
    const result = await withEnv({}, () => checkProvisioningWorkerHealth());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe("PROVISIONING_WORKER_UNHEALTHY");
      expect(result.status).toBe(503);
    }
  });

  it("returns healthy after the daemon publishes a heartbeat", async () => {
    await withEnv({}, async () => {
      await publishProvisioningWorkerHeartbeat();
      const result = await checkProvisioningWorkerHealth();
      expect(result.ok).toBe(true);
      if (result.ok === true) {
        expect(result.required).toBe(true);
        expect(typeof result.lastHeartbeatAt).toBe("string");
      }
    });
  });

  it("returns not-required when the env flag is off", async () => {
    const result = await runWithCloudBindingsAsync(
      { NODE_ENV: "development", MOCK_REDIS: "1" },
      () => checkProvisioningWorkerHealth(),
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.required).toBe(false);
    }
  });

  it("publish returns false when redis is not configured", async () => {
    const wrote = await runWithCloudBindingsAsync({ NODE_ENV: "production" }, () =>
      publishProvisioningWorkerHeartbeat(),
    );
    expect(wrote).toBe(false);
  });

  it("uses a stable redis key for observability", () => {
    expect(PROVISIONING_WORKER_HEARTBEAT_KEY).toBe("provisioning_worker:health");
  });
});
