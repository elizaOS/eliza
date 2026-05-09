import { describe, expect, it } from "vitest";
import { mediaActions } from "../actions/media.js";
import { createElizaPlugin } from "./eliza-plugin.js";

describe("createElizaPlugin", () => {
  it("registers media generation actions", () => {
    const plugin = createElizaPlugin();
    const actionNames = new Set(plugin.actions?.map((action) => action.name));

    for (const action of mediaActions) {
      expect(actionNames.has(action.name)).toBe(true);
    }
  });
});
