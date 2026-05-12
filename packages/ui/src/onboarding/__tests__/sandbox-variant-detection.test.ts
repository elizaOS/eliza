// @vitest-environment jsdom

/**
 * Focused unit coverage for AOSP sandbox-variant detection in
 * `../pre-seed-local-runtime.ts`.
 *
 * Background (see `docs/sandbox-mode.md` §AOSP audit and the file header
 * of `pre-seed-local-runtime.ts`): the AOSP ElizaOS variant is the only
 * mobile build with an on-device agent listening at
 * `127.0.0.1:31337`. Stock-Android Capacitor APKs (Play Store, Play
 * cloud-target) must NOT pre-seed — the user picks Cloud / Remote /
 * Local from `RuntimeGate` and only the explicit Local pick wires up
 * the loopback agent. Pre-seeding a stock APK as if it were AOSP would
 * dead-end boot in a `"Failed to connect to /127.0.0.1:31337"` loop.
 *
 * Detection is a pure user-agent test: `MainActivity.applyBrandUserAgentMarkers`
 * appends an `ElizaOS/<tag>` (or `ElizaOS/<tag>`) token to the WebView
 * UA only when `ro.elizaos.product` / `ro.elizaos.product` is set by
 * the AOSP product makefile. This file pins that contract directly via
 * the exported `isAospElizaUserAgent` helper, and exercises the
 * pre-seed wrapper (`preSeedAndroidLocalRuntimeIfFresh`) end-to-end so a
 * regression in either the regex or the navigator plumbing is caught.
 *
 * Resolves item 15 in `docs/QA-onboarding-followups.md`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    remove: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
  },
}));

import {
  isAospElizaUserAgent,
  preSeedAndroidLocalRuntimeIfFresh,
} from "../pre-seed-local-runtime";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

function setUserAgent(value: string): void {
  // The jsdom navigator's userAgent is configurable; redefine per test so
  // each case sees a clean slate. Resetting between tests is handled in
  // afterEach.
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  // Restore a neutral UA so an accidentally-leaked override from one
  // test cannot influence the next file's tests via a shared jsdom.
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (jsdom)",
  });
  vi.clearAllMocks();
});

describe("isAospElizaUserAgent — pure detection contract", () => {
  it("returns true for a real AOSP ElizaOS UA with version tag", () => {
    expect(
      isAospElizaUserAgent(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ElizaOS/2.4.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  it("returns true for the ElizaOS white-label marker", () => {
    expect(
      isAospElizaUserAgent(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ElizaOS/2.4.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  it("returns true when the marker appears mid-string with a pre-release tag", () => {
    expect(isAospElizaUserAgent("Random ElizaOS/2.4.0-pre.1 stuff")).toBe(true);
  });

  it("returns false for a stock-Android Capacitor UA (no ElizaOS marker)", () => {
    expect(
      isAospElizaUserAgent(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });

  it("returns false for a stock-iOS Capacitor UA (no ElizaOS marker)", () => {
    expect(
      isAospElizaUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
  });

  it("returns false for a malformed marker with no version after the slash", () => {
    // The `applyBrandUserAgentMarkers` contract is `ElizaOS/<tag>`. A
    // bare `ElizaOS` token without a slash + tag must NOT trigger the
    // pre-seed — otherwise an unrelated UA string containing the word
    // "ElizaOS" (a tech-blog footer, a generic SDK string) would
    // dead-end the boot.
    expect(isAospElizaUserAgent("Mozilla/5.0 ElizaOS Mobile/12345")).toBe(
      false,
    );
  });

  it("returns false for a marker followed by a trailing slash but no version", () => {
    expect(isAospElizaUserAgent("Mozilla/5.0 ElizaOS/ Mobile/12345")).toBe(
      false,
    );
  });

  it("returns false for an empty string without crashing", () => {
    expect(isAospElizaUserAgent("")).toBe(false);
  });

  it("returns false for null without crashing", () => {
    expect(isAospElizaUserAgent(null)).toBe(false);
  });

  it("returns false for undefined without crashing", () => {
    expect(isAospElizaUserAgent(undefined)).toBe(false);
  });

  it("does not match when the brand token has a leading word-boundary violation", () => {
    // e.g. "NotElizaOS/2.4.0" must not trigger the AOSP path. `\b`
    // ensures the brand starts at a word boundary.
    expect(isAospElizaUserAgent("Mozilla/5.0 NotElizaOS/2.4.0 Mobile")).toBe(
      false,
    );
  });
});

describe("preSeedAndroidLocalRuntimeIfFresh — wrapper observes navigator.userAgent", () => {
  it("pre-seeds when the AOSP marker is present", () => {
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ElizaOS/2.4.0 Mobile Safari/537.36",
    );

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(true);

    const raw = window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as { id: string };
    expect(parsed.id).toBe("local:android");
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
  });

  it("does NOT pre-seed when the AOSP marker is absent (stock Android Capacitor)", () => {
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
    );

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY)).toBeNull();
    expect(
      window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
    ).toBeNull();
  });

  it("does NOT pre-seed when the marker is malformed (no version after slash)", () => {
    setUserAgent("Mozilla/5.0 ElizaOS Mobile/12345");

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY)).toBeNull();
    expect(
      window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
    ).toBeNull();
  });
});
