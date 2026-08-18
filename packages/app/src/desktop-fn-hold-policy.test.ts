/** Verifies that desktop startup does not request global keyboard access in cloud-only builds. */

import { describe, expect, it } from "vitest";
import { shouldStartFnHoldMonitor } from "./desktop-fn-hold-policy";

describe("desktop Fn-hold startup policy", () => {
  it("does not start the global key monitor for cloud-only users", () => {
    expect(shouldStartFnHoldMonitor({ cloudOnly: true })).toBe(false);
  });

  it("preserves Fn-hold monitoring for local desktop builds", () => {
    expect(shouldStartFnHoldMonitor({ cloudOnly: false })).toBe(true);
  });
});
