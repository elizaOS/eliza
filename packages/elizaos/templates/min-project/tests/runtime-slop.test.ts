import { describe, expect, it } from "vitest";
import plugin from "../src/plugin.js";

describe("runtime template", () => {
  it("does not register template hello actions", () => {
    const actionNames = (plugin.actions ?? []).map((action) => action.name);

    expect(actionNames).not.toContain("__APP_NAME___HELLO");
    expect(actionNames).not.toContain("__PLUGIN_NAME___HELLO");
  });
});
