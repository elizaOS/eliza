import { describe, expect, it } from "vitest";

import { __internal } from "./index";

describe("activity collector parser", () => {
  it("parses valid focus and idle collector lines", () => {
    expect(
      __internal.parseCollectorLine(
        JSON.stringify({
          ts: 1700,
          event: "activate",
          bundleId: " com.apple.Safari ",
          appName: " Safari ",
          windowTitle: "Docs",
        }),
      ),
    ).toEqual({
      kind: "event",
      value: {
        ts: 1700,
        event: "activate",
        bundleId: "com.apple.Safari",
        appName: "Safari",
        windowTitle: "Docs",
      },
    });

    expect(
      __internal.parseCollectorLine(
        JSON.stringify({ ts: 1701, event: "hid_idle", idleSeconds: 12.5 }),
      ),
    ).toEqual({
      kind: "idle",
      value: { ts: 1701, event: "hid_idle", idleSeconds: 12.5 },
    });
  });

  it.each([
    "",
    "not json",
    "{}",
    JSON.stringify({ ts: Number.NaN, event: "activate" }),
    JSON.stringify({ ts: 1, event: "activate", bundleId: "", appName: "App" }),
    JSON.stringify({ ts: 1, event: "activate", bundleId: "id", appName: " " }),
    JSON.stringify({ ts: 1, event: "hid_idle", idleSeconds: -1 }),
    JSON.stringify({ ts: 1, event: "hid_idle", idleSeconds: "10" }),
    JSON.stringify({
      ts: 1,
      event: "__proto__",
      bundleId: "id",
      appName: "App",
    }),
  ])("ignores malformed collector line %#", (line) => {
    expect(__internal.parseCollectorLine(line)).toEqual({ kind: "ignored" });
    expect(__internal.parseEventLine(line)).toBeNull();
  });

  it("describes clean and fatal collector exits", () => {
    expect(__internal.describeCollectorExit(0, null)).toMatchObject({
      clean: true,
      reason: "collector exited (code=0, signal=null)",
    });
    expect(__internal.describeCollectorExit(1, null)).toMatchObject({
      clean: false,
      reason: "collector exited (code=1, signal=null)",
    });
  });
});
