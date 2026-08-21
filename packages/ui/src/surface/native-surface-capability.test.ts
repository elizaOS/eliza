/**
 * Pins the permanent-denial classifier to the native plugin's literal reject
 * strings and proves the cause-chain walk. The Android plugin source is read
 * from the monorepo so a native message rewrite fails HERE instead of silently
 * downgrading a permanent capability denial to a retryable transient fault.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NativeSurfaceUnavailableError } from "./capacitor-native-surface-shell";
import { isNativeSurfaceCapabilityDenial } from "./native-surface-capability";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const ANDROID_PLUGIN_SOURCE = resolve(
  REPO_ROOT,
  "plugins/plugin-native-browser-surface/android/src/main/java/ai/eliza/plugins/browsersurface/BrowserSurfacePlugin.kt",
);

// The exact device-capability reject strings the Android plugin emits. LP3
// (WebView 113, API 34) hits the first one: androidx.webkit MULTI_PROFILE
// landed in system WebView 115+, so `storage: "isolated"` can never be
// honoured on that device.
const MULTI_PROFILE_DENIAL =
  "isolated storage requires WebView multi-profile support; system WebView is too old";
const RENDERER_DENIAL =
  "isolated process policy requires an out-of-app WebView renderer, which is unavailable on this device";

describe("isNativeSurfaceCapabilityDenial", () => {
  it("stays pinned to the Android plugin's literal reject strings", () => {
    // Hard fail (never a skip) when the native source moves or is renamed —
    // the classifier's patterns would be matching nothing.
    const source = readFileSync(ANDROID_PLUGIN_SOURCE, "utf8");
    expect(source).toContain(`call.reject("${MULTI_PROFILE_DENIAL}")`);
    expect(source).toContain(`call.reject("${RENDERER_DENIAL}")`);
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
