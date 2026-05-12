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
  } as IAgentRuntime;
  return { runtime, plugins, registerPlugin };
}

describe("LifeOps Google plugin registration", () => {
  it("exposes the owner todo action for todos-routed planner turns", () => {
    const todoAction = appLifeOpsPlugin.actions?.find(
      (action) => action.name === "OWNER_TODOS",
    );

    expect(todoAction?.contexts).toContain("todos");
  });

  it("validates normal owner todo requests for the owner todo action", async () => {
    const todoAction = appLifeOpsPlugin.actions?.find(
      (action) => action.name === "OWNER_TODOS",
    );

    await expect(
      todoAction?.validate?.(
        { getRoom: async () => null } as IAgentRuntime,
        {
          content: { text: "add a todo: pick up dry cleaning tomorrow" },
        } as never,
      ),
    ).resolves.toBe(true);
  });

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

  it("registers generic Google connector routes without legacy LifeOps setup routes", () => {
    const routePaths = (lifeopsPlugin.routes ?? []).map((route) => route.path);

    expect(routePaths).toContain("/api/connectors/google/oauth/start");
    expect(routePaths).toContain("/api/connectors/google/oauth/callback");
    expect(routePaths).toContain("/api/connectors/google/accounts");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/status");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/accounts");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/success");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/start");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/callback");
    expect(routePaths).not.toContain(
      "/api/lifeops/connectors/google/disconnect",
    );
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
