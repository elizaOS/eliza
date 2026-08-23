import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { debug: vi.fn() },
}));

import { deduplicatePluginActions } from "./plugin-action-dedupe.ts";

describe("deduplicatePluginActions", () => {
  it("keeps the first occurrence of each action name", () => {
    const plugins = [
      { name: "p1", actions: [{ name: "a" }, { name: "b" }] },
      { name: "p2", actions: [{ name: "a" }, { name: "c" }] },
    ] as never;
    deduplicatePluginActions(plugins);
    const p1 = plugins[0] as { actions: { name: string }[] };
    const p2 = plugins[1] as { actions: { name: string }[] };
    expect(p1.actions.map((a) => a.name)).toEqual(["a", "b"]);
    expect(p2.actions.map((a) => a.name)).toEqual(["c"]);
  });

  it("handles plugins without actions", () => {
    const plugins = [
      { name: "p1" },
      { name: "p2", actions: [{ name: "x" }] },
    ] as never;
    expect(() => deduplicatePluginActions(plugins)).not.toThrow();
    const p2 = plugins[1] as { actions: { name: string }[] };
    expect(p2.actions.map((a) => a.name)).toEqual(["x"]);
  });
});
