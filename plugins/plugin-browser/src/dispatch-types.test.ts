import { describe, expect, it } from "vitest";
import { isIdempotentBrowserSubaction } from "./dispatch-types.js";

describe("isIdempotentBrowserSubaction", () => {
  it("does not classify a script-bearing wait as read-only", () => {
    expect(
      isIdempotentBrowserSubaction("wait", {
        script: 'document.body.dataset.probe = "1"',
      }),
    ).toBe(false);
  });

  it("keeps a pure wait classified as idempotent", () => {
    expect(isIdempotentBrowserSubaction("wait")).toBe(true);
  });

  it("keeps the read-only browser subactions classified as idempotent", () => {
    for (const subaction of [
      "list",
      "state",
      "get",
      "snapshot",
      "inspect",
    ] as const) {
      expect(isIdempotentBrowserSubaction(subaction)).toBe(true);
    }
  });
});
