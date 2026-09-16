/** Exercises permanent native capability-denial classification and cause-chain handling. */

import { describe, expect, it } from "vitest";
import { NativeSurfaceUnavailableError } from "./capacitor-native-surface-shell";
import { isNativeSurfaceCapabilityDenial } from "./native-surface-capability";

// The exact device-capability reject strings the Android plugin emits. LP3
// (WebView 113, API 34) hits the first one: androidx.webkit MULTI_PROFILE
// landed in system WebView 115+, so `storage: "isolated"` can never be
// honoured on that device.
const MULTI_PROFILE_DENIAL =
  "isolated storage requires WebView multi-profile support; system WebView is too old";
const RENDERER_DENIAL =
  "isolated process policy requires an out-of-app WebView renderer, which is unavailable on this device";
describe("isNativeSurfaceCapabilityDenial", () => {
  it("classifies the permanent denial messages received from the native bridge", () => {
    expect(
      isNativeSurfaceCapabilityDenial(new Error(MULTI_PROFILE_DENIAL)),
    ).toBe(true);
    expect(isNativeSurfaceCapabilityDenial(new Error(RENDERER_DENIAL))).toBe(
      true,
    );
  });

  it("classifies the denial when wrapped by the shell's typed transport error", () => {
    // Production path: the Capacitor rejection becomes the `cause` of a
    // NativeSurfaceUnavailableError whose own message is only the operation.
    const wrapped = new NativeSurfaceUnavailableError({
      surfaceId: "browser-tab:a",
      generation: 1,
      operation: "createSurface(browser-tab:a)",
      revision: 1,
      cause: new Error(MULTI_PROFILE_DENIAL),
    });
    expect(wrapped.message).not.toContain("multi-profile");
    expect(isNativeSurfaceCapabilityDenial(wrapped)).toBe(true);
  });

  it("classifies a doubly nested cause chain and non-Error string causes", () => {
    const deep = new Error("outer", {
      cause: new Error("middle", { cause: MULTI_PROFILE_DENIAL }),
    });
    expect(isNativeSurfaceCapabilityDenial(deep)).toBe(true);
  });

  it("does NOT classify transient transport faults as permanent", () => {
    expect(isNativeSurfaceCapabilityDenial(new Error("bounds rejected"))).toBe(
      false,
    );
    expect(
      isNativeSurfaceCapabilityDenial(
        new NativeSurfaceUnavailableError({
          surfaceId: "browser-tab:a",
          generation: 1,
          operation: "setBounds(browser-tab:a)",
          revision: 1,
          cause: new Error("native state unavailable"),
        }),
      ),
    ).toBe(false);
    expect(isNativeSurfaceCapabilityDenial(null)).toBe(false);
    expect(isNativeSurfaceCapabilityDenial(undefined)).toBe(false);
    expect(isNativeSurfaceCapabilityDenial(42)).toBe(false);
  });

  it("survives a self-referential cause cycle", () => {
    const a = new Error("first");
    const b = new Error("second", { cause: a });
    a.cause = b; // deliberately create a cycle
    expect(isNativeSurfaceCapabilityDenial(a)).toBe(false);
  });
});
