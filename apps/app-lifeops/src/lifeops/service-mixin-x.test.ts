import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLifeOpsConnectorGrant } from "./repository.js";
import { LifeOpsService } from "./service.js";

const ORIGINAL_ENV = {
  TWITTER_API_KEY: process.env.TWITTER_API_KEY,
  TWITTER_API_SECRET_KEY: process.env.TWITTER_API_SECRET_KEY,
  TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  TWITTER_USER_ID: process.env.TWITTER_USER_ID,
};

function makeRuntime(agentId = "agent-x") {
  return {
    agentId,
  } as unknown as ConstructorParameters<typeof LifeOpsService>[0];
}

describe("LifeOps X service mixin", () => {
  beforeEach(() => {
    process.env.TWITTER_API_KEY = "api-key";
    process.env.TWITTER_API_SECRET_KEY = "api-secret";
    process.env.TWITTER_ACCESS_TOKEN = "access-token";
    process.env.TWITTER_ACCESS_TOKEN_SECRET = "access-secret";
    process.env.TWITTER_USER_ID = "12345";
  });

  afterEach(() => {
    process.env.TWITTER_API_KEY = ORIGINAL_ENV.TWITTER_API_KEY;
    process.env.TWITTER_API_SECRET_KEY = ORIGINAL_ENV.TWITTER_API_SECRET_KEY;
    process.env.TWITTER_ACCESS_TOKEN = ORIGINAL_ENV.TWITTER_ACCESS_TOKEN;
    process.env.TWITTER_ACCESS_TOKEN_SECRET = ORIGINAL_ENV.TWITTER_ACCESS_TOKEN_SECRET;
    process.env.TWITTER_USER_ID = ORIGINAL_ENV.TWITTER_USER_ID;
    vi.restoreAllMocks();
  });

  it("treats env token mode as connected and exposes read/write and DM capabilities", async () => {
    const service = new LifeOpsService(makeRuntime());
    vi.spyOn(service.repository, "getConnectorGrant").mockResolvedValue(null);

    const status = await service.getXConnectorStatus("local");

    expect(status.mode).toBe("local");
    expect(status.connected).toBe(true);
    expect(status.hasCredentials).toBe(true);
    expect(status.feedRead).toBe(true);
    expect(status.feedWrite).toBe(true);
    expect(status.dmRead).toBe(true);
    expect(status.dmWrite).toBe(true);
    expect(status.grantedCapabilities).toEqual([
      "x.read",
      "x.write",
      "x.dm.read",
      "x.dm.write",
    ]);
  });

  it("preserves cloud_managed grants and dm-only capability splits", async () => {
    const service = new LifeOpsService(makeRuntime());
    const grant = createLifeOpsConnectorGrant({
      agentId: "agent-x",
      provider: "x",
      identity: {},
      grantedScopes: ["dm.read"],
      capabilities: ["x.read", "x.dm.read"],
      tokenRef: null,
      mode: "cloud_managed",
      metadata: {},
      lastRefreshAt: null,
      cloudConnectionId: "cloud-x-1",
    });
    vi.spyOn(service.repository, "getConnectorGrant").mockResolvedValue(grant);

    const status = await service.getXConnectorStatus("cloud_managed");

    expect(status.mode).toBe("cloud_managed");
    expect(status.connected).toBe(true);
    expect(status.feedRead).toBe(true);
    expect(status.feedWrite).toBe(false);
    expect(status.dmRead).toBe(true);
    expect(status.dmWrite).toBe(false);
  });
});
