/**
 * Unit tests for the ambient transport adapter helpers: status mapping,
 * transport selection (batch until the WS seam lands), and the WS TODO seam.
 */

import { describe, expect, it } from "vitest";
import {
  ambientStatusFromPendant,
  createAmbientWebSocketAdapter,
  selectAmbientTransport,
} from "./ambient-session-adapter";

describe("ambientStatusFromPendant", () => {
  it("maps unsupported and error verbatim", () => {
    expect(ambientStatusFromPendant("unsupported", false)).toBe("unsupported");
    expect(ambientStatusFromPendant("error", false)).toBe("error");
  });

  it("maps idle to idle", () => {
    expect(ambientStatusFromPendant("idle", false)).toBe("idle");
  });

  it("collapses connect steps into starting", () => {
    for (const s of ["requesting", "connecting", "reconnecting"] as const) {
      expect(ambientStatusFromPendant(s, false)).toBe("starting");
    }
  });

  it("treats live audio states as capturing", () => {
    for (const s of [
      "connected",
      "listening",
      "hearing",
      "transcribing",
    ] as const) {
      expect(ambientStatusFromPendant(s, false)).toBe("capturing");
    }
  });

  it("reports paused when the paused flag is set, regardless of live state", () => {
    expect(ambientStatusFromPendant("hearing", true)).toBe("paused");
    expect(ambientStatusFromPendant("paused", false)).toBe("paused");
  });
});

describe("ambient transport selection", () => {
  it("the WS adapter is an unimplemented seam today", () => {
    expect(createAmbientWebSocketAdapter()).toBeNull();
  });

  it("selects batch while the WS adapter is a null seam", () => {
    expect(selectAmbientTransport(true)).toBe("batch");
    expect(selectAmbientTransport(false)).toBe("batch");
  });
});
