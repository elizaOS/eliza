/** Verifies exact-once preservation of a real request across first-run setup. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumePendingFirstIntent,
  persistPendingFirstIntent,
} from "./pending-first-intent";

describe("pending first intent", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("returns the latest meaningful request exactly once", () => {
    expect(persistPendingFirstIntent("  plan my week  ")).toBe(true);
    expect(persistPendingFirstIntent("find dinner near me")).toBe(true);
    expect(consumePendingFirstIntent()).toBe("find dinner near me");
    expect(consumePendingFirstIntent()).toBeNull();
  });

  it("does not persist empty input", () => {
    expect(persistPendingFirstIntent("   ")).toBe(false);
    expect(consumePendingFirstIntent()).toBeNull();
  });

  it("drops a request when setup did not finish promptly", () => {
    expect(persistPendingFirstIntent("book dinner", () => 1_000)).toBe(true);
    expect(consumePendingFirstIntent(() => 31 * 60 * 1_000)).toBeNull();
  });
});
