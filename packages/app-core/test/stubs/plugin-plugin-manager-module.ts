/**
 * Test stub for `@elizaos/plugin-plugin-manager`.
 *
 * `packages/app-core/src/services/app-manager.test.ts` does
 *   `new PluginManagerService(runtime, { pluginDirectory })`
 * and then `vi.spyOn(pluginManager, "listInstalledPlugins" | "installPlugin"
 * | "uninstallPlugin" | ...)`. It also calls
 * `pluginRegistry.resetRegistryCache()` in beforeEach. The published
 * `@elizaos/plugin-plugin-manager` package ships a `dist/` that is not
 * built under `ELIZA_SKIP_LOCAL_UPSTREAMS=1`, and aliasing directly at
 * the submodule source path pulls in `fs-extra` and other dependencies
 * that are not installed at the repo root during unit tests. Stub
 * with a minimal class and namespace that exposes the methods the
 * tests rely on (all spy-stubbable, all no-ops).
 */

export class PluginManagerService {
  constructor(
    public runtime: unknown,
    public options?: { pluginDirectory?: string } & Record<string, unknown>,
  ) {}

  async listInstalledPlugins(): Promise<
    Array<{ name: string; version: string }>
  > {
    return [];
  }

  async installPlugin(
    _pluginName: string,
    _options?: unknown,
  ): Promise<{
    success: boolean;
    pluginName: string;
    version?: string;
    requiresRestart?: boolean;
    installPath?: string;
  }> {
    return { success: false, pluginName: _pluginName };
  }

  async uninstallPlugin(_pluginName: string): Promise<{ success: boolean }> {
    return { success: false };
  }

  async refreshRegistry(): Promise<Map<string, unknown>> {
    return new Map();
  }

  async getRegistryPlugin(_name: string): Promise<unknown> {
    return null;
  }
}

export class CoreManagerService {
  constructor(public runtime?: unknown) {}
}

export const pluginRegistry = {
  resetRegistryCache(): void {
    // no-op — stub for tests that reset state between runs
  },
  getRegistryEntry(_name: string): unknown {
    return null;
  },
  getRegistryPlugins(): Map<string, unknown> {
    return new Map();
  },
};

export const types = {};

// Match the real plugin's default export shape so anything that does
// `import plugin from "@elizaos/plugin-plugin-manager"` keeps working.
const plugin = {
  name: "plugin-plugin-manager-stub",
  description: "Test stub for @elizaos/plugin-plugin-manager (vitest alias).",
  services: [PluginManagerService, CoreManagerService] as const,
};

export default plugin;
