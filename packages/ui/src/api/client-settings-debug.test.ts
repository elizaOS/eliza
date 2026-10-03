// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-agent";

const originalBootConfig = getBootConfig();

describe("settings client debug output", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_SETTINGS_DEBUG", "false");
    vi.stubEnv("VITE_ELIZA_SETTINGS_DEBUG", "false");
    setBootConfig({ ...originalBootConfig, envAliases: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setBootConfig(originalBootConfig);
  });

  it.each(["ELIZA_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"])(
    "redacts credential values when %s enables logging",
    async (key) => {
      vi.stubEnv(key, "yes");
      const client = new ElizaClient("http://127.0.0.1:31337");
      const apiKey = "fixture-secret-must-not-appear-in-debug-output";
      const patch = { cloud: { apiKey, enabled: true } };
      const fetch = vi.spyOn(client, "fetch").mockResolvedValue(patch);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      expect(await client.updateConfig(patch)).toBe(patch);
      expect(fetch).toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(apiKey);
      expect(patch.cloud.apiKey).toBe(apiKey);
    },
  );

  it("keeps disabled logging quiet", async () => {
    const client = new ElizaClient("http://127.0.0.1:31337");
    vi.spyOn(client, "fetch").mockResolvedValue({});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    await client.getConfig();
    expect(debug).not.toHaveBeenCalled();
  });

  it("honors a branded build-time alias", async () => {
    vi.stubEnv("VITE_ELIZA_SETTINGS_DEBUG", "");
    vi.stubEnv("VITE_FIXTURE_SETTINGS_DEBUG", "on");
    setBootConfig({
      ...originalBootConfig,
      envAliases: [
        ["VITE_FIXTURE_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"],
      ],
    });
    const client = new ElizaClient("http://127.0.0.1:31337");
    vi.spyOn(client, "fetch").mockResolvedValue({});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    await client.getConfig();
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
