/**
 * Contract tests for the shared-onboarding provisioning poll body. The polling
 * effect fires immediately and every 5 s; these tests pin the request contract
 * (statusOnly flag, platform derivation, no user message) without requiring a
 * full React hook test harness.
 */
import { describe, expect, test } from "bun:test";
import { buildProvisioningPollBody } from "../src/lib/provisioning-poll-body";

describe("buildProvisioningPollBody", () => {
  test("always sends statusOnly: true", () => {
    const body = buildProvisioningPollBody("session-abc");
    expect(body.statusOnly).toBe(true);
  });

  test("never includes a message field", () => {
    const body = buildProvisioningPollBody("session-abc");
    expect(body).not.toHaveProperty("message");
  });

  test("uses blooio platform when a session id is present", () => {
    const body = buildProvisioningPollBody("platform:blooio:+1234567890");
    expect(body.platform).toBe("blooio");
    expect(body.sessionId).toBe("platform:blooio:+1234567890");
  });

  test("uses web platform and undefined session when no session id", () => {
    const body = buildProvisioningPollBody(null);
    expect(body.platform).toBe("web");
    expect(body.sessionId).toBeUndefined();
  });

  test("handles undefined session id", () => {
    const body = buildProvisioningPollBody(undefined);
    expect(body.platform).toBe("web");
    expect(body.sessionId).toBeUndefined();
    expect(body.statusOnly).toBe(true);
  });
});
