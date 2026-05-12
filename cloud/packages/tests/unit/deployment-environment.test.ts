import { describe, expect, test } from "bun:test";
import {
  isProductionDeployment,
  shouldBlockDevnetBypass,
  shouldBlockUnsafeWebhookSkip,
} from "@/lib/config/deployment-environment";

describe("deployment environment detection", () => {
  test("treats bare NODE_ENV=production as production", () => {
    expect(
      isProductionDeployment({
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  test("treats preview env as non-production", () => {
    expect(
      isProductionDeployment({
        NODE_ENV: "production",
        ENVIRONMENT: "preview",
      }),
    ).toBe(false);
  });

  test("treats production env as production", () => {
    expect(
      isProductionDeployment({
        NODE_ENV: "production",
        ENVIRONMENT: "production",
      }),
    ).toBe(true);
  });

  test("blocks unsafe webhook skip only for production deployments", () => {
    expect(
      shouldBlockUnsafeWebhookSkip({
        NODE_ENV: "production",
        ENVIRONMENT: "preview",
        SKIP_WEBHOOK_VERIFICATION: "true",
      }),
    ).toBe(false);
    expect(
      shouldBlockUnsafeWebhookSkip({
        NODE_ENV: "production",
        ENVIRONMENT: "production",
        SKIP_WEBHOOK_VERIFICATION: "true",
      }),
    ).toBe(true);
  });

  test("blocks devnet bypass only for production deployments", () => {
    expect(
      shouldBlockDevnetBypass({
        NODE_ENV: "production",
        ENVIRONMENT: "preview",
        DEVNET: "true",
      }),
    ).toBe(false);
    expect(
      shouldBlockDevnetBypass({
        NODE_ENV: "production",
        ENVIRONMENT: "production",
        DEVNET: "true",
      }),
    ).toBe(true);
  });
});
