/**
 * Pure-JS tests for the Android bridge type contract, the AndroidBridgeResult
 * discriminated union, error propagation, and constant values.
 *
 * These do NOT exercise any Kotlin code — that is unverified on this host
 * and lives behind the on-device validation checklist in
 * docs/ANDROID_CONSTRAINTS.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANDROID_BRIDGE_JS_NAME,
  ANDROID_DEFAULT_FPS,
  type AndroidAxNode,
  type AndroidBridgeErrorCode,
  type AndroidBridgeProbe,
  type AndroidBridgeResult,
  type AndroidComputerUseBridge,
  type AndroidMemoryPressureSnapshot,
  type AppUsageEntry,
  type CapturedScreenFrame,
  type GestureArgs,
  type GlobalAction,
  type MediaProjectionHandle,
  type SwipeGestureArgs,
  type TapGestureArgs,
} from "../mobile/android-bridge.js";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("Android bridge constants", () => {
  it("uses the same jsName as iOS so the planner needs no platform branch", () => {
    expect(ANDROID_BRIDGE_JS_NAME).toBe("ComputerUse");
  });

  it("default FPS is conservative for battery life", () => {
    expect(ANDROID_DEFAULT_FPS).toBe(1);
  });
});

// ── Android assistant/App Actions static source checks ───────────────────────

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const readRepoFile = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Android Assistant and App Actions routing source", () => {
  it("registers shortcuts.xml on the launcher activity", () => {
    const manifest = readRepoFile(
      "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
    );

    expect(manifest).toContain('android:name="android.app.shortcuts"');
    expect(manifest).toContain('android:resource="@xml/shortcuts"');
  });

  it("keeps default-assistant and voice-command surfaces out of the consumer manifest", () => {
    const manifest = readRepoFile(
      "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
    );

    expect(manifest).not.toContain("ElizaAssistActivity");
    expect(manifest).not.toContain("android.intent.action.ASSIST");
    expect(manifest).not.toContain("android.intent.action.VOICE_COMMAND");
    expect(manifest).not.toContain("android.app.role.ASSISTANT");
    expect(manifest).not.toContain("android.permission.BIND_VOICE_INTERACTION");
  });

  it("declares Play-compatible App Actions BIIs and static shortcuts", () => {
    const shortcuts = readRepoFile(
      "packages/app-core/platforms/android/app/src/main/res/xml/shortcuts.xml",
    );

    expect(shortcuts).toContain('android:name="actions.intent.OPEN_APP_FEATURE"');
    expect(shortcuts).toContain('android:name="actions.intent.CREATE_MESSAGE"');
    expect(shortcuts).toContain('android:name="actions.intent.GET_THING"');
    expect(shortcuts).toContain('android:name="feature"');
    expect(shortcuts).toContain('android:required="true"');
    expect(shortcuts).not.toContain("actions.intent.CREATE_THING");
    expect(shortcuts).toContain('android:shortcutId="eliza_app_action_chat"');
    expect(shortcuts).toContain('android:shortcutId="eliza_app_action_voice"');
    expect(shortcuts).toContain(
      'android:shortcutId="eliza_app_action_daily_brief"',
    );
    expect(shortcuts).toContain('android:shortcutId="eliza_app_action_new_task"');
    expect(shortcuts).toContain('android:shortcutId="eliza_app_action_tasks"');
    expect(shortcuts).toContain("source=android-app-actions");
    expect(shortcuts).toContain("source=android-static-shortcut");
    expect(shortcuts).toContain("eliza://feature/open?source=android-app-actions");
    expect(shortcuts).toContain("eliza://chat?source=android-app-actions&amp;action=chat");
    expect(shortcuts).toContain("eliza://lifeops/task/new?source=android-static-shortcut");
    expect(shortcuts.toLowerCase()).not.toContain("notification");
    expect(shortcuts).not.toContain("assistant/open");
    expect(shortcuts).not.toContain("android.intent.action.ASSIST");
    expect(shortcuts).not.toContain("android.intent.action.VOICE_COMMAND");
    expect(shortcuts).not.toContain("ScheduledTask");
  });
});

// ── AndroidBridgeResult discriminated union ───────────────────────────────────

describe("AndroidBridgeResult<T> discriminated union", () => {
  it("ok=true narrows to data", () => {
    const result: AndroidBridgeResult<number> = { ok: true, data: 42 };
    if (result.ok) {
      expect(result.data).toBe(42);
    } else {
      throw new Error("unreachable");
    }
  });

  it("ok=false narrows to code + message", () => {
    const result: AndroidBridgeResult<number> = {
      ok: false,
      code: "permission_denied",
      message: "CAMERA not granted",
    };
    if (!result.ok) {
      expect(result.code).toBe("permission_denied");
      expect(result.message).toBe("CAMERA not granted");
    } else {
      throw new Error("unreachable");
    }
  });

  it("all error codes are string literals", () => {
    const codes: AndroidBridgeErrorCode[] = [
      "unsupported_platform",
      "permission_denied",
      "permission_pending",
      "accessibility_unavailable",
      "capture_unavailable",
      "camera_not_open",
      "invalid_argument",
      "internal_error",
    ];
    for (const code of codes) {
      expect(typeof code).toBe("string");
    }
  });
});

// ── AndroidAxNode (WS6 Scene.ax shape) ────────────────────────────────────────

describe("AndroidAxNode shape", () => {
  it("has all required fields matching WS6 Scene.ax contract", () => {
    const node: AndroidAxNode = {
      id: "42",
      role: "android.widget.Button",
      label: "OK",
      bbox: { x: 100, y: 200, w: 80, h: 40 },
      actions: ["click", "focus"],
    };
    expect(node.id).toBe("42");
    expect(node.role).toBe("android.widget.Button");
    expect(node.bbox.w).toBe(80);
    expect(node.bbox.h).toBe(40);
    expect(node.actions).toContain("click");
  });

  it("label is nullable (nodes without text or contentDescription)", () => {
    const node: AndroidAxNode = {
      id: "0",
      role: "android.view.View",
      label: null,
      bbox: { x: 0, y: 0, w: 100, h: 100 },
      actions: [],
    };
    expect(node.label).toBeNull();
  });
});

// ── GestureArgs discriminated union ───────────────────────────────────────────

describe("GestureArgs discriminated union", () => {
  it("tap gesture has type='tap', x, y", () => {
    const g: GestureArgs = { type: "tap", x: 300, y: 500 };
    if (g.type === "tap") {
      expect(g.x).toBe(300);
      expect(g.y).toBe(500);
    }
  });

  it("swipe gesture has type='swipe' and target coords", () => {
    const g: GestureArgs = { type: "swipe", x: 100, y: 800, x2: 100, y2: 200, durationMs: 400 };
    if (g.type === "swipe") {
      expect(g.x2).toBe(100);
      expect(g.y2).toBe(200);
      expect(g.durationMs).toBe(400);
    }
  });

  it("swipe durationMs is optional", () => {
    const g: SwipeGestureArgs = { type: "swipe", x: 0, y: 0, x2: 100, y2: 100 };
    expect(g.durationMs).toBeUndefined();
  });
});

// ── GlobalAction union ────────────────────────────────────────────────────────

describe("GlobalAction", () => {
  it("covers the four required system actions", () => {
    const actions: GlobalAction[] = ["back", "home", "recents", "notifications"];
    expect(actions).toHaveLength(4);
  });
});

// ── CapturedScreenFrame ───────────────────────────────────────────────────────

describe("CapturedScreenFrame", () => {
  it("has the expected shape", () => {
    const frame: CapturedScreenFrame = {
      jpegBase64: "base64string",
      width: 1080,
      height: 1920,
      timestampMs: Date.now(),
    };
    expect(frame.jpegBase64).toBe("base64string");
    expect(frame.width).toBe(1080);
    expect(frame.height).toBe(1920);
    expect(typeof frame.timestampMs).toBe("number");
  });
});

// ── AndroidMemoryPressureSnapshot ────────────────────────────────────────────

describe("AndroidMemoryPressureSnapshot", () => {
  it("has all required pressure fields", () => {
    const snap: AndroidMemoryPressureSnapshot = {
      level: "low",
      freeMb: 512,
      maxMb: 4096,
      usedMb: 3584,
      source: "android-runtime",
    };
    expect(snap.level).toBe("low");
    expect(snap.freeMb).toBe(512);
    expect(snap.source).toBe("android-runtime");
  });

  it("pressure levels are the expected string literals", () => {
    const valid = ["nominal", "low", "critical"];
    for (const level of valid) {
      const snap: AndroidMemoryPressureSnapshot = {
        level: level as AndroidMemoryPressureSnapshot["level"],
        freeMb: 0,
        maxMb: 0,
        usedMb: 0,
        source: "android-runtime",
      };
      expect(valid).toContain(snap.level);
    }
  });
});

// ── AndroidBridgeProbe ───────────────────────────────────────────────────────

describe("AndroidBridgeProbe", () => {
  it("reports Android platform metadata and capability booleans", async () => {
    const fakeBridge = buildFakeAndroidBridge({
      probe: async () => ({
        ok: true,
        data: {
          platform: "android",
          osVersion: "14",
          sdkInt: 34,
          capabilities: {
            mediaProjection: true,
            accessibilityService: false,
            usageStats: true,
            camera: false,
            aospPrivileged: false,
          },
        },
      }),
    });

    const result = await fakeBridge.probe();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected probe success");

    const probe: AndroidBridgeProbe = result.data;
    expect(probe.platform).toBe("android");
    expect(probe.osVersion).toBe("14");
    expect(probe.sdkInt).toBe(34);
    expect(typeof probe.capabilities.mediaProjection).toBe("boolean");
    expect(typeof probe.capabilities.accessibilityService).toBe("boolean");
    expect(typeof probe.capabilities.usageStats).toBe("boolean");
    expect(typeof probe.capabilities.camera).toBe("boolean");
    expect(typeof probe.capabilities.aospPrivileged).toBe("boolean");
  });
});

// ── AppUsageEntry (enumerateApps) ─────────────────────────────────────────────

describe("AppUsageEntry", () => {
  it("has the expected shape matching WS6 enumerateApps interface", () => {
    const entry: AppUsageEntry = {
      packageName: "com.android.chrome",
      label: "Chrome",
      lastUsedMs: Date.now() - 60_000,
      totalForegroundMs: 3_600_000,
      isForeground: false,
    };
    expect(entry.packageName).toBe("com.android.chrome");
    expect(entry.totalForegroundMs).toBe(3_600_000);
    expect(typeof entry.isForeground).toBe("boolean");
  });
});

// ── onTrimMemory → MemoryArbiter pressure call chain (structural) ─────────────

describe("onTrimMemory → dispatchMemoryPressure call chain", () => {
  /**
   * Structural verification of the call chain described in android-bridge.ts:
   *
   *   Kotlin ComponentCallbacks2.onTrimMemory(level)
   *   → notifyListeners("memoryPressure", { level, freeMb })
   *   → JS: AndroidComputerUseBridge.dispatchMemoryPressure({ level, freeMb })
   *   → capacitorPressureSource.dispatch(level, freeMb) [WS1]
   *   → MemoryArbiter pressure listener
   *
   * This test verifies the JS signature accepts the expected payload.
   */
  it("dispatchMemoryPressure accepts nominal level", async () => {
    const fakeBridge = buildFakeAndroidBridge({
      dispatchMemoryPressure: async ({ level, freeMb }) => {
        expect(level).toBe("nominal");
        expect(freeMb).toBe(2048);
        return { ok: true, data: { ok: true } };
      },
    });
    const result = await fakeBridge.dispatchMemoryPressure({ level: "nominal", freeMb: 2048 });
    expect(result.ok).toBe(true);
  });

  it("dispatchMemoryPressure accepts critical level without freeMb", async () => {
    const fakeBridge = buildFakeAndroidBridge({
      dispatchMemoryPressure: async ({ level }) => {
        expect(level).toBe("critical");
        return { ok: true, data: { ok: true } };
      },
    });
    const result = await fakeBridge.dispatchMemoryPressure({ level: "critical" });
    expect(result.ok).toBe(true);
  });

  it("getAccessibilityTree error propagates as ok=false", async () => {
    const fakeBridge = buildFakeAndroidBridge({
      getAccessibilityTree: async () => ({
        ok: false,
        code: "accessibility_unavailable",
        message: "Service not running",
      }),
    });
    const result = await fakeBridge.getAccessibilityTree();
    if (!result.ok) {
      expect(result.code).toBe("accessibility_unavailable");
    } else {
      throw new Error("expected failure");
    }
  });
});

// ── Fake bridge builder ───────────────────────────────────────────────────────

function buildFakeAndroidBridge(
  overrides: Partial<AndroidComputerUseBridge> = {},
): AndroidComputerUseBridge {
  const stub = <T>(code: AndroidBridgeErrorCode = "internal_error"): Promise<AndroidBridgeResult<T>> =>
    Promise.resolve({ ok: false, code, message: "stub" });

  return {
    probe: () => stub("internal_error"),
    startMediaProjection: () => stub("internal_error"),
    stopMediaProjection: () => stub("internal_error"),
    captureFrame: () => stub("capture_unavailable"),
    getAccessibilityTree: () => stub("accessibility_unavailable"),
    dispatchGesture: () => stub("accessibility_unavailable"),
    performGlobalAction: () => stub("accessibility_unavailable"),
    setText: () => stub("accessibility_unavailable"),
    enumerateApps: () => stub("permission_denied"),
    getMemoryPressureSnapshot: () => stub("internal_error"),
    dispatchMemoryPressure: () => stub("internal_error"),
    startCamera: () => stub("permission_denied"),
    stopCamera: () => Promise.resolve({ ok: true, data: { ok: true } }),
    captureFrameCamera: () => stub("camera_not_open"),
    ...overrides,
  };
}
