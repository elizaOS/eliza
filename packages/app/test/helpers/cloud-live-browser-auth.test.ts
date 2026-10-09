// @vitest-environment node
import {
  configureStoredStewardTokenScope,
  readStoredStewardToken,
} from "@elizaos/plugin-elizacloud/steward-session-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCloudLiveBrowserAuthSeed,
  seedCloudLiveBrowserAuth,
} from "../cloud-live-browser-auth";

afterEach(() => vi.unstubAllGlobals());

describe("Cloud-live browser credential scope", () => {
  it("makes the seeded credential readable only for its configured Cloud environment", async () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", {
      localStorage,
      location: { protocol: "http:", hostname: "127.0.0.1" },
    });
    localStorage.setItem("steward_session_token", "test-only-bearer");
    configureStoredStewardTokenScope("https://api.eliza.app/api/v1");
    expect(readStoredStewardToken()).toBeNull();
    expect(
      await seedCloudLiveBrowserAuth(
        {
          async addInitScript(script, seed) {
            script(seed);
          },
        },
        {
          ELIZA_UI_SMOKE_CLOUD_LIVE: "1",
          ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "production",
          ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
          ELIZAOS_CLOUD_API_KEY: "test-only-bearer",
        },
      ),
    ).toBe(true);
    configureStoredStewardTokenScope("https://api.eliza.app/api/v1");
    expect(readStoredStewardToken()).toBe("test-only-bearer");
    configureStoredStewardTokenScope("https://api-staging.eliza.app/api/v1");
    expect(readStoredStewardToken()).toBeNull();
  });

  it("rejects a mismatched environment before handing off a bearer", () => {
    expect(() =>
      resolveCloudLiveBrowserAuthSeed({
        ELIZA_UI_SMOKE_CLOUD_LIVE: "1",
        ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
        ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
        ELIZAOS_CLOUD_API_KEY: "test-only-bearer",
      }),
    ).toThrow("expected the staging Cloud API");
  });

  it("leaves ordinary smoke runs unseeded", () => {
    expect(
      resolveCloudLiveBrowserAuthSeed({
        ELIZAOS_CLOUD_API_KEY: "test-only-bearer",
      }),
    ).toBeNull();
  });
});
