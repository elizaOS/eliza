/**
 * Runtime template guard that keeps removed sample actions from reappearing in
 * generated minimal plugins.
 */

import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("runtime template", () => {
  it("does not register the template hello action", () => {
    const actionNames = (plugin.actions ?? []).map((action) => action.name);

    expect(actionNames).not.toContain("__PLUGIN_NAME___HELLO");
  });
});
