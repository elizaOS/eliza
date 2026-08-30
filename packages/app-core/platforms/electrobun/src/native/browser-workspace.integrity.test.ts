/** Verifies browser workspace diagnostics remain complete unless pagination is explicitly requested. */
import { describe, expect, it } from "vitest";
import {
  type BrowserWorkspaceEvent,
  BrowserWorkspaceManager,
} from "./browser-workspace";

type BrowserWorkspaceInternals = {
  recordEvent: (
    type: BrowserWorkspaceEvent["type"],
    tab: null,
    payload: Record<string, unknown>,
  ) => BrowserWorkspaceEvent;
};

describe("BrowserWorkspaceManager diagnostic integrity", () => {
  it("retains every event and only paginates when the caller asks", async () => {
    const manager = new BrowserWorkspaceManager();
    for (let index = 0; index < 1_250; index += 1) {
      await manager.openTab({ title: `tab-${index}` });
    }

    const complete = await manager.listEvents();
    expect(complete.events).toHaveLength(1_250);
    expect(complete.events[0]?.title).toBe("tab-0");

    const page = await manager.listEvents({ limit: 3 });
    expect(page.events.map((event) => event.title)).toEqual([
      "tab-1247",
      "tab-1248",
      "tab-1249",
    ]);
  });

  it("preserves long, deep, and wide event payloads", async () => {
    const manager = new BrowserWorkspaceManager();
    const internals = manager as unknown as BrowserWorkspaceInternals;
    const longText = "complete".repeat(100);
    const wide = Array.from({ length: 75 }, (_, index) => index);
    const deep = { one: { two: { three: { four: { five: longText } } } } };

    internals.recordEvent("eval.error", null, { longText, wide, deep });

    const [event] = (await manager.listEvents()).events;
    expect(event?.payload).toEqual({ longText, wide, deep });
  });

  it("rejects cyclic diagnostic payloads instead of silently replacing content", () => {
    const manager = new BrowserWorkspaceManager();
    const internals = manager as unknown as BrowserWorkspaceInternals;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => internals.recordEvent("eval.error", null, { cyclic })).toThrow(
      "must not contain cycles",
    );
  });
});
