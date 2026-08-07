/** Validates the browser boundary for realtime voice control frames. */

import { describe, expect, it } from "vitest";
import { parseServerControl } from "./voice-session-protocol";

describe("voice session server protocol", () => {
  it("accepts a bounded navigate-view handoff", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "navigate_view",
          viewId: " notes ",
          subview: " recent ",
          traceId: " trace-1 ",
        }),
      ),
    ).toEqual({
      t: "navigate_view",
      viewId: "notes",
      subview: "recent",
      traceId: "trace-1",
    });
  });

  it("rejects navigate-view frames without a usable target or trace", () => {
    expect(
      parseServerControl(
        JSON.stringify({ t: "navigate_view", viewId: "", traceId: "trace-1" }),
      ),
    ).toBeNull();
    expect(
      parseServerControl(
        JSON.stringify({ t: "navigate_view", viewId: "notes", traceId: 7 }),
      ),
    ).toBeNull();
  });

  it("rejects an invalid optional subview rather than dropping it", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "navigate_view",
          viewId: "notes",
          subview: {},
          traceId: "trace-1",
        }),
      ),
    ).toBeNull();
  });
});
