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
  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.REQUIRE_PROVISIONING_WORKER;
    delete process.env.MOCK_REDIS;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.REQUIRE_PROVISIONING_WORKER;
    delete process.env.MOCK_REDIS;
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
