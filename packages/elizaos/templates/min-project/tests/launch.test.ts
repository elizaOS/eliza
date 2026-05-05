import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import plugin from "../src/plugin.js";

describe("__APP_NAME__ plugin", () => {
  it("registers a name and at least one action", () => {
    expect(plugin.name).toBe("__APP_NAME__");
    expect(plugin.actions?.length).toBeGreaterThan(0);
  });

  it("exposes a hello action with a runnable handler", async () => {
    const action = plugin.actions?.[0];
    expect(action).toBeDefined();
    if (!action) return;
    // Minimal smoke test — the handler accepts a wide signature; cast
    // through `unknown` so this stays clean under any tsconfig the
    // scaffolded app adopts (strict mode flags `@ts-expect-error` as
    // unused when the call site already typechecks).
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
