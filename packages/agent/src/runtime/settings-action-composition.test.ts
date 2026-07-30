/**
 * Regression coverage for the production SETTINGS action composition. The
 * built-in eliza plugin composes app-control's section registry with its
 * provider/backend/world operations. Runtime registration keeps the first
 * owner without mutating either plugin's standalone action surface.
 */

import {
  type Action,
  AgentRuntime,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type Plugin,
} from "@elizaos/core";
import { appControlPlugin } from "@elizaos/plugin-app-control";
import { describe, expect, it } from "vitest";
import { createElizaPlugin } from "./eliza-plugin.ts";

const RUNTIME = {
  character: {},
  getSetting: () => null,
} as unknown as IAgentRuntime;
const MESSAGE = { entityId: "owner" } as unknown as Memory;

function clonePlugin(plugin: Plugin): Plugin {
  return {
    ...plugin,
    actions: plugin.actions ? [...plugin.actions] : undefined,
  };
}

function actionParameter(settingsAction: Action, name: string) {
  return settingsAction.parameters?.find(
    (parameter) => parameter.name === name,
  );
}

describe("default SETTINGS action composition", () => {
  it("registers pendant session sync as private raw runtime routes", () => {
    const plugin = createElizaPlugin();
    expect(plugin.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "POST",
          path: "/api/pendant/sessions",
          rawPath: true,
        }),
        expect.objectContaining({
          type: "POST",
          path: "/api/pendant/sessions/:sessionId/segments",
          rawPath: true,
        }),
        expect.objectContaining({
          type: "PUT",
          path: "/api/pendant/sessions/:sessionId/insight-refs",
          rawPath: true,
        }),
      ]),
    );

    for (const path of [
      "/api/pendant/sessions",
      "/api/pendant/sessions/:sessionId/segments",
      "/api/pendant/sessions/:sessionId/insight-refs",
    ]) {
      expect(
        plugin.routes?.find((route) => route.path === path)?.public,
      ).not.toBe(true);
    }
  });

  it("registers one composed SETTINGS action without mutating either plugin", async () => {
    const plugins = [
      createElizaPlugin(),
      clonePlugin(appControlPlugin),
    ] satisfies Plugin[];
    const runtime = new AgentRuntime({
      character: { name: "settings-composition-test" },
    });
    for (const action of plugins.flatMap((plugin) => plugin.actions ?? [])) {
      runtime.registerAction(action);
    }

    const settingsActions = runtime.actions.filter(
      (action) => action.name === "SETTINGS",
    );
    expect(settingsActions).toHaveLength(1);
    expect(
      plugins
        .flatMap((plugin) => plugin.actions ?? [])
        .filter((action) => action.name === "SETTINGS"),
    ).toHaveLength(2);
    const [settingsAction] = settingsActions;

    const actionSchema = actionParameter(settingsAction, "action")?.schema;
    expect(actionSchema?.enum).toEqual(
      expect.arrayContaining([
        "list",
        "get",
        "set",
        "update_ai_provider",
        "show_backends",
      ]),
    );
    expect(actionParameter(settingsAction, "section")).toBeDefined();
    expect(actionParameter(settingsAction, "capability")).toBeDefined();
    expect(actionParameter(settingsAction, "backend")).toBeDefined();

    const listed = await settingsAction.handler(RUNTIME, MESSAGE, undefined, {
      parameters: { action: "list" },
    } as HandlerOptions);
    if (!listed) throw new Error("SETTINGS action returned no list result");
    expect(listed.success).toBe(true);
    expect(listed.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "permissions", via: "SETTINGS" }),
      ]),
    );

    const backends = await settingsAction.handler(RUNTIME, MESSAGE, undefined, {
      parameters: { action: "show_backends" },
    } as HandlerOptions);
    if (!backends)
      throw new Error("SETTINGS action returned no backend result");
    expect(backends.success).toBe(true);
    expect(backends.data).toMatchObject({ op: "show_backends" });
  });
});
