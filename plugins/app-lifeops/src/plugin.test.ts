import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  appLifeOpsPlugin,
  ensureLifeOpsGooglePluginRegistered,
} from "./plugin.js";
import { lifeopsPlugin } from "./routes/plugin.js";

function createRuntimeWithPluginRegistration(initialPlugins: Plugin[] = []): {
  runtime: IAgentRuntime;
  plugins: Plugin[];
  registerPlugin: ReturnType<typeof vi.fn>;
} {
  const plugins = [...initialPlugins];
  let runtime: IAgentRuntime;
  const registerPlugin = vi.fn(async (plugin: Plugin) => {
    plugins.push(plugin);
    await plugin.init?.({}, runtime);
  });
  runtime = {
    plugins,
    registerPlugin,
    getService: vi.fn(() => null),
    getSetting: vi.fn(() => undefined),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  return { runtime, plugins, registerPlugin };
}

describe("LifeOps Google plugin registration", () => {
  it("declares plugin-google for app and route plugin dependency resolution", () => {
    expect(appLifeOpsPlugin.dependencies).toContain("@elizaos/plugin-google");
    expect(lifeopsPlugin.dependencies).toContain("@elizaos/plugin-google");
  });

  it("registers plugin-google when LifeOps is registered directly", async () => {
    const { runtime, plugins, registerPlugin } =
      createRuntimeWithPluginRegistration();

    await ensureLifeOpsGooglePluginRegistered(runtime);

    expect(registerPlugin).toHaveBeenCalledTimes(1);
    expect(plugins.map((plugin) => plugin.name)).toContain("google");
    expect(registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "google",
        init: expect.any(Function),
      }),
    );
  });

  it("keeps generic Google connector routes ahead of legacy LifeOps setup routes", () => {
    const routePaths = (lifeopsPlugin.routes ?? []).map((route) => route.path);

    expect(routePaths).toContain("/api/connectors/google/oauth/start");
    expect(routePaths).toContain("/api/connectors/google/oauth/callback");
    expect(routePaths).toContain("/api/lifeops/connectors/google/start");
    expect(
      routePaths.indexOf("/api/connectors/google/oauth/start"),
    ).toBeLessThan(routePaths.indexOf("/api/lifeops/connectors/google/start"));
  });

  it("does not register plugin-google twice", async () => {
    const { runtime, registerPlugin } = createRuntimeWithPluginRegistration([
      {
        name: "google",
        description: "already loaded",
      } as Plugin,
    ]);

    await ensureLifeOpsGooglePluginRegistered(runtime);

    expect(registerPlugin).not.toHaveBeenCalled();
  });
});
