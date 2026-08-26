/** Verifies platform-specific native plugin ownership before raw Capacitor sync. */

import { describe, expect, it } from "vitest";
import {
  resolveAndroidCapacitorPlugins,
  resolveCapacitorHttpEnabled,
  resolveCapacitorLoggingBehavior,
} from "../capacitor.config";

describe("Android Capacitor plugin selection", () => {
  it("includes the Bun host and excludes the iOS-only llama bridge (#17465)", () => {
    const selected = resolveAndroidCapacitorPlugins({
      "@capacitor/core": "8.4.0",
      "@capacitor/app": "8.1.0",
      "@elizaos/capacitor-bun-runtime": "workspace:*",
      "@elizaos/capacitor-talkmode": "workspace:*",
      "llama-cpp-capacitor": "0.1.5",
      react: "19.0.0",
    });

    expect(selected).toEqual([
      "@capacitor/app",
      "@elizaos/capacitor-bun-runtime",
      "@elizaos/capacitor-talkmode",
    ]);
  });

  it("uses WebView fetch for the Android Cloud build only", () => {
    expect(resolveCapacitorHttpEnabled("android", "cloud")).toBe(false);
    expect(resolveCapacitorHttpEnabled("android", undefined, "1")).toBe(false);
    expect(resolveCapacitorHttpEnabled(undefined, undefined, "1")).toBe(false);
    expect(resolveCapacitorHttpEnabled("android", "local")).toBe(true);
    expect(resolveCapacitorHttpEnabled("ios", "cloud")).toBe(true);
  });
});

describe("Capacitor logging behavior", () => {
  it("suppresses native bridge payloads in the debuggable launcher lane", () => {
    expect(
      resolveCapacitorLoggingBehavior({
        ELIZA_ANDROID_LAUNCHER_BUILD: "1",
      }),
    ).toBe("none");
  });

  it("retains debug-only logging for other lanes", () => {
    expect(resolveCapacitorLoggingBehavior({})).toBe("debug");
  });
});
