import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("runtime scaffold", () => {
  it("does not register the placeholder hello action", () => {
    const actionNames = (plugin.actions ?? []).map((action) => action.name);

    expect(actionNames).not.toContain("__PLUGIN_NAME___HELLO");
  });
});
