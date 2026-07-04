/**
 * Verifies captureTaskResponse / peekTaskResponse.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  captureTaskResponse,
  cleanForFailoverContext,
  peekTaskResponse,
} from "../../src/services/ansi-utils.js";

// #9146 — these take their state (buffers/markers) as parameters, so they're
// fixture-testable without mocks. Pin the consume-vs-peek contract + the
// failover-context cleaning (trim, drop blanks/noise/workdir-echo).
const buffers = () => new Map([["s", ["alpha", "bravo", "charlie"]]]);

describe("captureTaskResponse / peekTaskResponse", () => {
  it("returns the buffered lines from the marker onward", () => {
    expect(captureTaskResponse("s", buffers(), new Map([["s", 1]]))).toBe(
      "bravo\ncharlie",
    );
  });

  it("captureTaskResponse CONSUMES the marker; peek does NOT", () => {
    const markers = new Map([["s", 1]]);
    captureTaskResponse("s", buffers(), markers);
    expect(markers.has("s")).toBe(false); // consumed

    const peekMarkers = new Map([["s", 1]]);
    expect(peekTaskResponse("s", buffers(), peekMarkers)).toBe(
      "bravo\ncharlie",
    );
    expect(peekMarkers.has("s")).toBe(true); // preserved
  });

  it("returns '' when the session has no buffer or no marker", () => {
    expect(captureTaskResponse("missing", buffers(), new Map())).toBe("");
    expect(peekTaskResponse("missing", buffers(), new Map())).toBe("");
  });
});

describe("cleanForFailoverContext", () => {
  it("trims, drops blank lines, and strips CLI banner noise", () => {
    const out = cleanForFailoverContext(
      "  Real output line  \n\n  Claude Code v1.2.3  \n  Second line  ",
    );
    expect(out).toBe("Real output line\nSecond line");
  });

  it("drops a line that just echoes the workdir path", () => {
    const out = cleanForFailoverContext(
      "Building\n/home/user/proj\nDone",
      "/home/user/proj",
    );
    expect(out).toBe("Building\nDone");
  });
});
