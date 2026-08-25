/** Exercises cloud-only env hydration with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { hydrateCloudOnlyEnv } from "./cloud-only-boot";

describe("hydrateCloudOnlyEnv", () => {
  it("raises cloud-only flags and points a clean consumer install at its baked Cloud API", () => {
    const env: Record<string, string | undefined> = {};
    const result = hydrateCloudOnlyEnv(true, "https://api.eliza.app", env);
    expect(env.ELIZA_DESKTOP_CLOUD_ONLY).toBe("1");
    expect(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT).toBe("1");
    expect(env.ELIZA_DESKTOP_API_BASE).toBe("https://api.eliza.app");
    expect(result.applied.sort()).toEqual([
      "ELIZA_DESKTOP_API_BASE",
      "ELIZA_DESKTOP_CLOUD_ONLY",
      "ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
    ]);
  });

  it("is a no-op for a non-cloud-only brand", () => {
    const env: Record<string, string | undefined> = {};
    const result = hydrateCloudOnlyEnv(false, null, env);
    expect(env).toEqual({});
    expect(result.applied).toEqual([]);
  });

  it("never overwrites explicit operator env — even a falsy opt-out", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_DESKTOP_CLOUD_ONLY: "0",
      ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "0",
    };
    const result = hydrateCloudOnlyEnv(true, "https://api.eliza.app", env);
    expect(env.ELIZA_DESKTOP_CLOUD_ONLY).toBe("0");
    expect(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT).toBe("0");
    expect(result.applied).toEqual(["ELIZA_DESKTOP_API_BASE"]);
  });

  it("fills only the missing flag when one is already set", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_DESKTOP_CLOUD_ONLY: "1",
    };
    const result = hydrateCloudOnlyEnv(true, "https://api.eliza.app", env);
    expect(result.applied).toEqual([
      "ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
      "ELIZA_DESKTOP_API_BASE",
    ]);
    expect(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT).toBe("1");
  });

  it("preserves every supported explicit external API override", () => {
    for (const key of [
      "ELIZA_DESKTOP_TEST_API_BASE",
      "ELIZA_DESKTOP_API_BASE",
      "ELIZA_API_BASE_URL",
      "ELIZA_API_BASE",
    ]) {
      const env: Record<string, string | undefined> = {
        [key]: "https://operator.example",
      };
      hydrateCloudOnlyEnv(true, "https://api.eliza.app", env);
      expect(env[key]).toBe("https://operator.example");
      if (key !== "ELIZA_DESKTOP_API_BASE") {
        expect(env.ELIZA_DESKTOP_API_BASE).toBeUndefined();
      }
    }
  });
});
