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
    const result = await action.handler(
      // @ts-expect-error — minimal smoke test, runtime not exercised
      {},
      // @ts-expect-error — minimal smoke test, message not exercised
      {},
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ success: true });
  });
});
