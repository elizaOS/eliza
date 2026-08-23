/**
 * Coverage for persistence-guard.
 */
import { describe, expect, it, afterEach } from "vitest";
import { allowEphemeralCloudStateFallback, assertPersistentCloudStateConfigured } from "./persistence-guard.js";
describe("persistence-guard", () => {
  const orig = process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE;
  afterEach(() => {
    if (orig === undefined) delete process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE;
    else process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE = orig;
  });
  it("allows when flag true", () => {
    process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE = "true";
    expect(allowEphemeralCloudStateFallback()).toBe(true);
  });
  it("allows when not production", () => {
    process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE = "false";
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    expect(allowEphemeralCloudStateFallback()).toBe(true);
    process.env.NODE_ENV = prev;
  });
  it("assert does not throw when allowed", () => {
    expect(() => assertPersistentCloudStateConfigured("test", true)).not.toThrow();
  });
  it("throws when not configured in prod", () => {
    process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE = "false";
    const prevEnv = process.env.ENVIRONMENT;
    const prevNode = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.ENVIRONMENT = "production";
    expect(() => assertPersistentCloudStateConfigured("feat", false)).toThrow();
    process.env.NODE_ENV = prevNode;
    if (prevEnv === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = prevEnv;
  });
});
