import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, resolveChannel } from "./update-checker.ts";

const baseConfig = {
  update: {
    channel: "stable" as const,
    lastCheckAt: new Date().toISOString(),
    lastCheckVersion: "9.9.9",
    lastCheckChannel: "stable" as const,
  },
};

function makeRuntime(config = baseConfig) {
  const cache = new Map<string, unknown>();
  cache.set("elizaConfig", config);
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (_key: string): Promise<boolean> => false,
    getService: () => null,
  };
}

vi.mock("../config/config.ts", async () => ({
  loadElizaConfig: () => baseConfig,
  saveElizaConfig: (cfg: unknown) => {
    baseConfig = cfg as typeof baseConfig;
    return Promise.resolve();
  },
}));

let baseConfig = { ...baseConfig };

describe("checkForUpdate", () => {
  it("returns cached result for the same channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ "dist-tags": { latest: "9.9.9", beta: "9.9.9-beta.1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = makeRuntime();
    const result = await checkForUpdate({}, runtime);
    expect(result.cached).toBe(true);
    expect(result.latestVersion).toBe("9.9.9");
    expect(result.channel).toBe("stable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bypasses cache when ELIZA_UPDATE_CHANNEL env changes the effective channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ "dist-tags": { latest: "9.9.9", beta: "9.9.9-beta.1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("ELIZA_UPDATE_CHANNEL", "beta");

    const runtime = makeRuntime();
    const result = await checkForUpdate({}, runtime);
    expect(result.cached).toBe(false);
    expect(result.channel).toBe("beta");
    expect(result.latestVersion).toBe("9.9.9-beta.1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(baseConfig.update.lastCheckChannel).toBe("beta");

    vi.unstubEnv("ELIZA_UPDATE_CHANNEL");
  });
});
