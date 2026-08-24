import { afterEach, describe, expect, it } from "vitest";
import {
  allowEphemeralCloudStateFallback,
  assertPersistentCloudStateConfigured,
} from "./persistence-guard.js";

describe("persistence-guard", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("allows fallback when flag set", () => {
    process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE = "true";
    expect(allowEphemeralCloudStateFallback()).toBe(true);
  });

  it("disallows in production without flag", () => {
    delete process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE;
    process.env.NODE_ENV = "production";
    process.env.ENVIRONMENT = "production";
    expect(allowEphemeralCloudStateFallback()).toBe(false);
  });

  it("throws when persistent not configured in prod", () => {
    delete process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE;
    process.env.NODE_ENV = "production";
    process.env.ENVIRONMENT = "production";
    expect(() => assertPersistentCloudStateConfigured("test", false)).toThrow(/Redis/);
  });

  it("does not throw when backend present", () => {
    delete process.env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE;
    process.env.NODE_ENV = "production";
    expect(() => assertPersistentCloudStateConfigured("test", true)).not.toThrow();
  });
});
