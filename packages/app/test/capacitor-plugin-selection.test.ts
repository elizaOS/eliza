/** Verifies platform-specific native plugin ownership before raw Capacitor sync. */

import { describe, expect, it } from "vitest";
import {
  resolveAndroidCapacitorPlugins,
  resolveCapacitorAndroidIdentity,
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

  it("excludes FCM from the LP3 VPS fallback without dropping local notifications", () => {
    const selected = resolveAndroidCapacitorPlugins(
      {
        "@capacitor/local-notifications": "8.0.0",
        "@capacitor/push-notifications": "8.1.2",
        "@elizaos/capacitor-location": "workspace:*",
      },
      true,
    );

    expect(selected).toEqual([
      "@capacitor/local-notifications",
      "@elizaos/capacitor-location",
    ]);
  });

  it("uses WebView fetch for the Android Cloud build only", () => {
    expect(resolveCapacitorHttpEnabled("android", "cloud")).toBe(false);
    expect(resolveCapacitorHttpEnabled("android", undefined, "1")).toBe(false);
    expect(resolveCapacitorHttpEnabled(undefined, undefined, "1")).toBe(false);
    expect(resolveCapacitorHttpEnabled("android", "local")).toBe(true);
    expect(resolveCapacitorHttpEnabled("ios", "cloud")).toBe(true);
  });

  it("keeps the emitted identity and Android project selection aligned", () => {
    const stagingIdentity = resolveCapacitorAndroidIdentity(
      {
        ELIZA_APP_ID: " ai.elizaos.app.staging ",
        ELIZA_IOS_APP_ID: "ai.elizaos.app.ios",
      },
      "ai.elizaos.app",
    );

    expect(stagingIdentity).toEqual({
      appId: "ai.elizaos.app.staging",
      projectPath: "android",
    });
    expect(
      resolveCapacitorAndroidIdentity({ ELIZA_APP_ID: " " }, "ai.elizaos.app"),
    ).toEqual({
      appId: "ai.elizaos.app",
      projectPath: "../app-core/platforms/android",
    });
    expect(
      resolveCapacitorAndroidIdentity(
        { ELIZA_IOS_APP_ID: "ai.elizaos.app.ios" },
        "ai.elizaos.app",
      ),
    ).toEqual({ appId: "ai.elizaos.app.ios", projectPath: "android" });
  });
});

describe("Capacitor logging behavior", () => {
  it("suppresses native bridge payloads in every Android Cloud lane", () => {
    expect(
      resolveCapacitorLoggingBehavior({
        ELIZA_ANDROID_LAUNCHER_BUILD: "1",
      }),
    ).toBe("none");
    expect(
      resolveCapacitorLoggingBehavior({
        ELIZA_ANDROID_CLOUD_BUILD: "1",
      }),
    ).toBe("none");
    expect(
      resolveCapacitorLoggingBehavior({
        ELIZA_ANDROID_CLOUD_BUILD: "true",
      }),
    ).toBe("none");
    expect(
      resolveCapacitorLoggingBehavior({
        ELIZA_ANDROID_CLOUD_HYBRID_BUILD: "1",
      }),
    ).toBe("none");
    expect(
      resolveCapacitorLoggingBehavior({
        ELIZA_ANDROID_VPS_SIDECAR: "1",
      }),
    ).toBe("none");
  });

  it("retains debug-only logging for other lanes", () => {
    expect(resolveCapacitorLoggingBehavior({})).toBe("debug");
  });
});
