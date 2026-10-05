import { afterEach, expect, it, vi } from "vitest";

// These checks import the complete plugin and its provider dependency graph.
const PLUGIN_IMPORT_TIMEOUT_MS = 60_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it(
  "host policy removes only Cloud account actions from the assembled plugin",
  async () => {
    vi.stubEnv("ELIZAOS_CLOUD_ACCOUNT_ACTIONS", "disabled");
    const { default: plugin } = await import("../../src/index.ts");
    expect(plugin.actions).toEqual([]);
    expect(Object.keys(plugin.models ?? {}).length).toBeGreaterThan(0);
    expect(plugin.providers?.length).toBeGreaterThan(0);
  },
  PLUGIN_IMPORT_TIMEOUT_MS
);
it(
  "default keeps account actions and malformed policy fails closed",
  async () => {
    vi.stubEnv("ELIZAOS_CLOUD_ACCOUNT_ACTIONS", undefined);
    const { default: plugin } = await import("../../src/index.ts");
    expect(plugin.actions).toHaveLength(3);
    vi.resetModules();
    vi.stubEnv("ELIZAOS_CLOUD_ACCOUNT_ACTIONS", "disable-typo");
    await expect(import("../../src/index.ts")).rejects.toMatchObject({
      code: "CLOUD_ACCOUNT_ACTION_POLICY_INVALID",
    });
  },
  PLUGIN_IMPORT_TIMEOUT_MS
);
