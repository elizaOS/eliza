import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("__PLUGIN_NAME__", () => {
  it("exports a plugin with name, one action, and one provider", () => {
    expect(plugin.name).toBe("__PLUGIN_NAME__");
    expect(plugin.actions?.length).toBe(1);
    expect(plugin.providers?.length).toBe(1);
  });

  it("hello action runs and returns success", async () => {
    const action = plugin.actions?.[0];
    expect(action).toBeDefined();
    if (!action) return;
    // Minimal smoke test — cast through `unknown` so this stays clean
    // under any tsconfig the scaffolded plugin adopts (strict mode flags
    // `@ts-expect-error` as unused when the call site already typechecks).
    const fakeRuntime = {} as unknown as IAgentRuntime;
    const fakeMessage = {} as unknown as Memory;
    const result = await action.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ success: true });
  });
});
