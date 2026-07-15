/** Regression coverage for the real Cloud Playwright browser-auth handoff. */
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_LIVE_STEWARD_TOKEN_KEY,
  type CloudLiveInitScriptTarget,
  resolveCloudLiveBrowserAuthSeed,
  seedCloudLiveBrowserAuth,
} from "./cloud-live-browser-auth";

describe("Cloud-live browser auth", () => {
  it("hands the validated workflow bearer to the browser Steward store", async () => {
    let installedSeed: { storageKey: string; token: string } | null = null;
    const target: CloudLiveInitScriptTarget = {
      addInitScript: vi.fn(async (_script, seed) => {
        installedSeed = seed;
      }),
    };

    await expect(
      seedCloudLiveBrowserAuth(target, {
        ELIZA_UI_SMOKE_CLOUD_LIVE: "1",
        ELIZAOS_CLOUD_API_KEY: "  cloud-live-key  ",
      }),
    ).resolves.toBe(true);

    expect(installedSeed).toEqual({
      storageKey: CLOUD_LIVE_STEWARD_TOKEN_KEY,
      token: "cloud-live-key",
    });
    expect(target.addInitScript).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["default mode", { ELIZAOS_CLOUD_API_KEY: "cloud-live-key" }],
    [
      "missing key",
      { ELIZA_UI_SMOKE_CLOUD_LIVE: "1", ELIZAOS_CLOUD_API_KEY: undefined },
    ],
    [
      "whitespace-only key",
      { ELIZA_UI_SMOKE_CLOUD_LIVE: "1", ELIZAOS_CLOUD_API_KEY: " \t\n" },
    ],
  ])("does not seed browser auth in %s", async (_, env) => {
    const target: CloudLiveInitScriptTarget = {
      addInitScript: vi.fn(async () => {}),
    };

    await expect(seedCloudLiveBrowserAuth(target, env)).resolves.toBe(false);
    expect(target.addInitScript).not.toHaveBeenCalled();
    expect(resolveCloudLiveBrowserAuthSeed(env)).toBeNull();
  });
});
