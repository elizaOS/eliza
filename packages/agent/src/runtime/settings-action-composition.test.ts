/**
 * Regression coverage for the production SETTINGS action composition. The
 * default runtime loads the built-in eliza plugin before plugin-app-control, so
 * this test pins the one-action contract that keeps both settings operation
 * families reachable after plugin action dedupe.
 */

import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core";
import { appControlPlugin } from "@elizaos/plugin-app-control";
import { describe, expect, it } from "vitest";
import { createElizaPlugin } from "./eliza-plugin.ts";
import { deduplicatePluginActions } from "./plugin-action-dedupe.ts";

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
  it("keeps exactly one SETTINGS action with legacy and section-registry operations", async () => {
    const plugins = [
      createElizaPlugin(),
      clonePlugin(appControlPlugin),
    ] satisfies Plugin[];
    deduplicatePluginActions(plugins);

    const settingsActions = plugins.flatMap((plugin) =>
      (plugin.actions ?? []).filter((action) => action.name === "SETTINGS"),
    );
    expect(settingsActions).toHaveLength(1);
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
