/**
 * Unit coverage for the per-environment Eliza app-origin resolver (#15161).
 * The console dashboard links out to the app for create-agent; that link must
 * stay within the SAME environment or a signed-in staging user bounces to the
 * PROD app (different tenant/session). Pure function, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  PROD_ELIZA_APP_ORIGIN,
  resolveElizaAppOrigin,
  STAGING_ELIZA_APP_ORIGIN,
} from "./cloud-agent-base";

describe("resolveElizaAppOrigin", () => {
  it("resolves the staging console apex to the staging app (not prod)", () => {
    // REGRESSION for #15161: staging.elizacloud.ai must NOT resolve to the
    // prod app.elizacloud.ai — that was the bounce-to-prod bug.
    expect(resolveElizaAppOrigin("staging.elizacloud.ai")).toBe(
      STAGING_ELIZA_APP_ORIGIN,
    );
    expect(resolveElizaAppOrigin("staging.elizacloud.ai")).not.toBe(
      PROD_ELIZA_APP_ORIGIN,
    );
  });

  it("resolves the staging api + app hosts to the staging app", () => {
    expect(resolveElizaAppOrigin("api-staging.elizacloud.ai")).toBe(
      STAGING_ELIZA_APP_ORIGIN,
    );
    expect(resolveElizaAppOrigin("app-staging.elizacloud.ai")).toBe(
      STAGING_ELIZA_APP_ORIGIN,
    );
  });

  it("is case-insensitive and trims the host", () => {
    expect(resolveElizaAppOrigin("  STAGING.ElizaCloud.AI  ")).toBe(
      STAGING_ELIZA_APP_ORIGIN,
    );
  });

  it("resolves every prod console host to the prod app (behavior-preserving)", () => {
    for (const host of [
      "elizacloud.ai",
      "www.elizacloud.ai",
      "app.elizacloud.ai",
      "api.elizacloud.ai",
      "dev.elizacloud.ai",
    ]) {
      expect(resolveElizaAppOrigin(host)).toBe(PROD_ELIZA_APP_ORIGIN);
    }
  });

  it("fails safe to the prod app for unknown / local / empty hosts", () => {
    expect(resolveElizaAppOrigin("localhost")).toBe(PROD_ELIZA_APP_ORIGIN);
    expect(resolveElizaAppOrigin("agent-123.elizacloud.ai")).toBe(
      PROD_ELIZA_APP_ORIGIN,
    );
    expect(resolveElizaAppOrigin("")).toBe(PROD_ELIZA_APP_ORIGIN);
    expect(resolveElizaAppOrigin(null)).toBe(PROD_ELIZA_APP_ORIGIN);
    expect(resolveElizaAppOrigin(undefined)).toBe(PROD_ELIZA_APP_ORIGIN);
  });
});
