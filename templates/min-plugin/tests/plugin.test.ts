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
