/** Exercises cloud-only env hydration with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { hydrateCloudOnlyEnv } from "./cloud-only-boot";

describe("hydrateCloudOnlyEnv", () => {
  it("raises both cloud-only env flags for a cloud-only brand", () => {
    const env: Record<string, string | undefined> = {};
    const result = hydrateCloudOnlyEnv(true, env);
    expect(env.ELIZA_DESKTOP_CLOUD_ONLY).toBe("1");
    expect(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT).toBe("1");
    expect(result.applied.sort()).toEqual([
      "ELIZA_DESKTOP_CLOUD_ONLY",
      "ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
    ]);
  });

  it("is a no-op for a non-cloud-only brand", () => {
    const env: Record<string, string | undefined> = {};
    const result = hydrateCloudOnlyEnv(false, env);
    expect(env).toEqual({});
    expect(result.applied).toEqual([]);
  });

  it("never overwrites explicit operator env — even a falsy opt-out", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_DESKTOP_CLOUD_ONLY: "0",
      ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "0",
    };
    const result = hydrateCloudOnlyEnv(true, env);
    expect(env.ELIZA_DESKTOP_CLOUD_ONLY).toBe("0");
    expect(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT).toBe("0");
    expect(result.applied).toEqual([]);
  });

  it("fills only the missing flag when one is already set", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_DESKTOP_CLOUD_ONLY: "1",
    };
    const result = hydrateCloudOnlyEnv(true, env);
    expect(result.applied).toEqual(["ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT"]);
    expect(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT).toBe("1");
  });
});
