// Exercises deployment environment.gates behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "bun:test";
import { shouldBlockDevnetBypass, shouldBlockUnsafeWebhookSkip } from "./deployment-environment";

/**
 * Coverage for the two production safety gates that were untested (#9145 deploy
 * safety). Both are pure `(env) => boolean` and only fire when the bypass flag
 * is exactly "true" AND the env is a production deployment (ENVIRONMENT, else
 * NODE_ENV). The companion `isProductionDeployment` / `shouldBlockRegistrarStub`
 * are covered in deployment-environment.test.ts.
 */

describe("shouldBlockUnsafeWebhookSkip", () => {
  it("blocks only when SKIP_WEBHOOK_VERIFICATION=true AND production", () => {
    expect(
      shouldBlockUnsafeWebhookSkip({
        SKIP_WEBHOOK_VERIFICATION: "true",
        ENVIRONMENT: "production",
      }),
    ).toBe(true);
    expect(
      shouldBlockUnsafeWebhookSkip({
        SKIP_WEBHOOK_VERIFICATION: "true",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("allows the skip outside production", () => {
    expect(
      shouldBlockUnsafeWebhookSkip({
        SKIP_WEBHOOK_VERIFICATION: "true",
        NODE_ENV: "test",
      }),
    ).toBe(false);
    expect(shouldBlockUnsafeWebhookSkip({ SKIP_WEBHOOK_VERIFICATION: "true" })).toBe(false);
  });

  it("does not block when the flag is unset or not exactly 'true'", () => {
    expect(shouldBlockUnsafeWebhookSkip({ ENVIRONMENT: "production" })).toBe(false);
    expect(
      shouldBlockUnsafeWebhookSkip({
        SKIP_WEBHOOK_VERIFICATION: "1",
        ENVIRONMENT: "production",
      }),
    ).toBe(false);
  });
});

describe("shouldBlockDevnetBypass", () => {
  it("blocks only when DEVNET=true AND production", () => {
    expect(shouldBlockDevnetBypass({ DEVNET: "true", ENVIRONMENT: "production" })).toBe(true);
    expect(shouldBlockDevnetBypass({ DEVNET: "true", NODE_ENV: "production" })).toBe(true);
  });

  it("allows devnet outside production, when unset, or not exactly 'true'", () => {
    expect(shouldBlockDevnetBypass({ DEVNET: "true", NODE_ENV: "test" })).toBe(false);
    expect(shouldBlockDevnetBypass({ ENVIRONMENT: "production" })).toBe(false);
    expect(shouldBlockDevnetBypass({ DEVNET: "1", ENVIRONMENT: "production" })).toBe(false);
  });

  it("honors ENVIRONMENT over NODE_ENV (staging is not production)", () => {
    expect(
      shouldBlockDevnetBypass({
        DEVNET: "true",
        ENVIRONMENT: "staging",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });
});
