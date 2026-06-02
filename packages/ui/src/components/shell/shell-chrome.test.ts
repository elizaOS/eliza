// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MINIMAL_SHELL reads localStorage once at module load, so each case resets the
// module registry and seeds localStorage before re-importing.
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("MINIMAL_SHELL", () => {
  it("defaults to true when the preference is unset", async () => {
    const { MINIMAL_SHELL } = await import("./shell-chrome");
    expect(MINIMAL_SHELL).toBe(true);
  });

  it("is false when eliza:minimal-shell is explicitly '0'", async () => {
    window.localStorage.setItem("eliza:minimal-shell", "0");
    const { MINIMAL_SHELL } = await import("./shell-chrome");
    expect(MINIMAL_SHELL).toBe(false);
  });

  it("is true for any non-'0' value", async () => {
    window.localStorage.setItem("eliza:minimal-shell", "1");
    const { MINIMAL_SHELL } = await import("./shell-chrome");
    expect(MINIMAL_SHELL).toBe(true);
  });

  it("falls back to true if localStorage access throws", async () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const { MINIMAL_SHELL } = await import("./shell-chrome");
    expect(MINIMAL_SHELL).toBe(true);
    spy.mockRestore();
  });
});
