/** Verifies the plugin registers its routes and auto-registers the Google plugin dependency when absent. Deterministic vitest with a stubbed runtime plugin registrar. */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  ensureLifeOpsGooglePluginRegistered,
  personalAssistantPlugin,
} from "./plugin.js";
import { lifeOpsProvider } from "./providers/lifeops.js";
import { personalAssistantRoutesPlugin } from "./routes/plugin.js";

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
  it("stamps every owner action and provider with a non-overridable disclosure gate", () => {
    expect(personalAssistantPlugin.actions?.length).toBeGreaterThan(0);
    for (const action of personalAssistantPlugin.actions ?? []) {
      expect(action.disclosureGate).toEqual({ require: "owner_exclusive" });
    }
    expect(personalAssistantPlugin.providers?.length).toBeGreaterThan(0);
    for (const provider of personalAssistantPlugin.providers ?? []) {
      expect(provider.disclosureGate).toEqual({ require: "owner_exclusive" });
      expect(provider.cacheStable).toBe(false);
    }
  });

  it("does not infer a private LifeOps audience from sender-role metadata", async () => {
    // A DM-stamped message carrying self-declared owner metadata, and no
    // delivery-audience attestation. The provider reads the attested
    // destination, never the sender's claim about itself, so this stays denied.
    const result = await lifeOpsProvider.get(
      { agentId: "agent", reportError: vi.fn() } as unknown as IAgentRuntime,
      {
        entityId: "owner",
        agentId: "agent",
        roomId: "room",
        content: {
          text: "show my calendar",
          channelType: "DM",
          metadata: { role: "OWNER", isOwner: true },
        },
      } as never,
      { values: {}, data: {}, text: "" },
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("exposes the owner todo action for todos-routed planner turns", () => {
    const todoAction = personalAssistantPlugin.actions?.find(
      (action) => action.name === "OWNER_TODOS",
    );

    expect(todoAction?.contexts).toContain("todos");
  });

  it("validates normal owner todo requests for the owner todo action", async () => {
    const todoAction = personalAssistantPlugin.actions?.find(
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

  it("declares plugin-google-workspace for app and route plugin dependency resolution", () => {
    expect(personalAssistantPlugin.dependencies).toContain(
      "@elizaos/plugin-google-workspace",
    );
    expect(personalAssistantRoutesPlugin.dependencies).toContain(
      "@elizaos/plugin-google-workspace",
    );
  });

  it("registers plugin-google-workspace when LifeOps is registered directly", async () => {
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
    const routePaths = (personalAssistantRoutesPlugin.routes ?? []).map(
      (route) => route.path,
    );

    expect(routePaths).toContain("/api/connectors/google/oauth/start");
    expect(routePaths).toContain("/api/connectors/google/oauth/callback");
    expect(routePaths).toContain("/api/connectors/google/accounts");
    // The OAuth callback, account listing, and success page stay on the
    // generic connector-account surface; LifeOps must not register a second
    // callback or account store.
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/accounts");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/success");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/start");
    expect(routePaths).not.toContain("/api/lifeops/connectors/google/callback");
  });

  it("exposes the LifeOps connection manager over the shared connector-account manager", () => {
    const routePaths = (personalAssistantRoutesPlugin.routes ?? []).map(
      (route) => route.path,
    );

    // These three routes project connector accounts into LifeOps grant DTOs,
    // map least-privilege capabilities onto Google scopes, and fail closed on
    // an unusable callback origin before redirecting. They delegate to the
    // same connector-account manager as the generic routes above.
    expect(routePaths).toContain("/api/lifeops/connectors/google/status");
    expect(routePaths).toContain("/api/lifeops/connectors/google/connect");
    expect(routePaths).toContain("/api/lifeops/connectors/google/disconnect");
  });

  it("does not register plugin-google-workspace twice", async () => {
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
