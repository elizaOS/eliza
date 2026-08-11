/** Verifies cloud-auth-complete-signal message matching and handoff surface detection. */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCloudAuthCompleteMessage,
  isCloudAuthHandoffSurface,
  publishCloudAuthComplete,
  subscribeCloudAuthComplete,
} from "./cloud-auth-complete-signal";

let originalName = "";
let originalOpener: PropertyDescriptor | undefined;

beforeEach(() => {
  originalName = window.name;
  originalOpener = Object.getOwnPropertyDescriptor(window, "opener");
});

afterEach(() => {
  window.name = originalName;
  if (originalOpener) {
    Object.defineProperty(window, "opener", originalOpener);
  } else {
    delete (window as { opener?: unknown }).opener;
  }
  vi.restoreAllMocks();
});

describe("isCloudAuthCompleteMessage", () => {
  it("accepts a well-formed complete payload", () => {
    expect(
      isCloudAuthCompleteMessage({
        type: "eliza-cloud-auth-complete",
        sessionId: "sess-1",
      }),
    ).toBe(true);
  });

  it("rejects mismatched session when filtered", () => {
    expect(
      isCloudAuthCompleteMessage(
        { type: "eliza-cloud-auth-complete", sessionId: "sess-1" },
        "other",
      ),
    ).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isCloudAuthCompleteMessage(null)).toBe(false);
    expect(isCloudAuthCompleteMessage({ type: "nope" })).toBe(false);
  });
});

describe("isCloudAuthHandoffSurface", () => {
  it("is true for the named cloud-login popup", () => {
    window.name = "eliza-cloud-auth";
    expect(isCloudAuthHandoffSurface()).toBe(true);
  });

  it("is true when a live opener exists", () => {
    window.name = "";
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: { closed: false },
    });
    expect(isCloudAuthHandoffSurface()).toBe(true);
  });

  it("is false for a plain top-level tab", () => {
    window.name = "";
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: null,
    });
    expect(isCloudAuthHandoffSurface()).toBe(false);
  });
});

describe("publish / subscribe", () => {
  it("publish and subscribe are safe no-ops or callable without throw", () => {
    const unsub = subscribeCloudAuthComplete(() => {});
    expect(() => publishCloudAuthComplete("sess-bc")).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });
});
