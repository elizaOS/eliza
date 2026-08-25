/**
 * Same-named unit coverage for the shared permission-prober bridge helpers.
 * Drives the live `_bridge` module: state construction, native-status maps,
 * bundle-id / entitlement / dylib path resolution against real temp trees,
 * Darwin osascript and TCC sqlite reads, the native dylib loader cache, and
 * non-Darwin short-circuits via an isolated re-import. Does not invoke
 * request-side native prompts or the Darwin System Settings opener.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildState,
  getNativeDylib,
  hasEmbeddedProvisioningEntitlement,
  IS_DARWIN,
  mapAVAuthStatus,
  mapNativePrivacyAuthStatus,
  mapUNAuthStatus,
  PLATFORM,
  platformUnsupportedState,
  queryAppleEventsTccStatus,
  queryTccStatus,
  resolveBundleId,
  resolvePackagedNativePermissionsDylib,
  runOsascript,
} from "./_bridge.ts";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-bridge-"));
  tempRoots.push(root);
  return root;
}

function fakeAppExec(root: string, appName = "Example.app"): string {
  const macos = path.join(root, appName, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  return path.join(macos, "Example");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("PLATFORM / IS_DARWIN", () => {
  it("mirrors process.platform at module load", () => {
    expect(PLATFORM).toBe(process.platform);
    expect(IS_DARWIN).toBe(process.platform === "darwin");
  });
});

describe("buildState", () => {
  it("fills lastChecked, platform, and canRequest from status when omitted", () => {
    const before = Date.now();
    const granted = buildState("camera", "granted");
    const undetermined = buildState("microphone", "not-determined");
    const after = Date.now();

    expect(granted.id).toBe("camera");
    expect(granted.status).toBe("granted");
    expect(granted.canRequest).toBe(false);
    expect(granted.platform).toBe(PLATFORM);
    expect(granted.lastChecked).toBeGreaterThanOrEqual(before);
    expect(granted.lastChecked).toBeLessThanOrEqual(after);
    expect("restrictedReason" in granted).toBe(false);
    expect("lastRequested" in granted).toBe(false);
    expect("lastBlockedFeature" in granted).toBe(false);

    expect(undetermined.id).toBe("microphone");
    expect(undetermined.status).toBe("not-determined");
    expect(undetermined.canRequest).toBe(true);
  });

  it("keeps an explicit canRequest even when it disagrees with status", () => {
    const state = buildState("notes", "granted", { canRequest: true });
    expect(state.canRequest).toBe(true);
  });

  it("copies optional fields only when they are not undefined", () => {
    const blocked = {
      app: "calendar",
      action: "create",
      at: 1_700_000_000_000,
    };
    const state = buildState("calendar", "restricted", {
      canRequest: false,
      restrictedReason: "os_policy",
      lastRequested: 0,
      lastBlockedFeature: blocked,
    });
    expect(state.restrictedReason).toBe("os_policy");
    expect(state.lastRequested).toBe(0);
    expect(state.lastBlockedFeature).toEqual(blocked);

    const omitted = buildState("shell", "denied", {
      restrictedReason: undefined,
      lastRequested: undefined,
      lastBlockedFeature: undefined,
    });
    expect("restrictedReason" in omitted).toBe(false);
    expect("lastRequested" in omitted).toBe(false);
    expect("lastBlockedFeature" in omitted).toBe(false);
  });
});

describe("platformUnsupportedState", () => {
  it("marks the permission not-applicable and unrequestable", () => {
    const state = platformUnsupportedState("health");
    expect(state).toMatchObject({
      id: "health",
      status: "not-applicable",
      canRequest: false,
      restrictedReason: "platform_unsupported",
      platform: PLATFORM,
    });
  });
});

describe("mapAVAuthStatus", () => {
  it("maps AVCaptureDevice codes and treats every other value as not-determined", () => {
    expect(mapAVAuthStatus(2)).toBe("granted");
    expect(mapAVAuthStatus(1)).toBe("denied");
    expect(mapAVAuthStatus(3)).toBe("restricted");
    expect(mapAVAuthStatus(0)).toBe("not-determined");
    expect(mapAVAuthStatus(4)).toBe("not-determined");
    expect(mapAVAuthStatus(-1)).toBe("not-determined");
    expect(mapAVAuthStatus(99)).toBe("not-determined");
  });
});

describe("mapUNAuthStatus", () => {
  it("maps UNUserNotificationCenter codes", () => {
    expect(mapUNAuthStatus(2)).toBe("granted");
    expect(mapUNAuthStatus(1)).toBe("denied");
    expect(mapUNAuthStatus(3)).toBe("restricted");
    expect(mapUNAuthStatus(0)).toBe("not-determined");
    expect(mapUNAuthStatus(4)).toBe("not-determined");
  });

  it("throws ElizaError for a negative native status", () => {
    expect(() => mapUNAuthStatus(-1)).toThrow(ElizaError);
    try {
      mapUNAuthStatus(-3);
      expect.unreachable("expected mapUNAuthStatus to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect(error).toMatchObject({
        code: "NOTIFICATION_AUTHORIZATION_FAILED",
        context: { nativeStatus: -3 },
        severity: "fatal",
      });
      expect((error as Error).message).toMatch(
        /notification authorization request/i,
      );
    }
  });
});

describe("mapNativePrivacyAuthStatus", () => {
  it("maps EventKit/Contacts codes including write-only as restricted", () => {
    expect(mapNativePrivacyAuthStatus(2)).toBe("granted");
    expect(mapNativePrivacyAuthStatus(1)).toBe("denied");
    expect(mapNativePrivacyAuthStatus(3)).toBe("restricted");
    expect(mapNativePrivacyAuthStatus(4)).toBe("restricted");
    expect(mapNativePrivacyAuthStatus(0)).toBe("not-determined");
    expect(mapNativePrivacyAuthStatus(5)).toBe("not-determined");
    expect(mapNativePrivacyAuthStatus(-1)).toBe("not-determined");
  });
});

describe("resolvePackagedNativePermissionsDylib", () => {
  it("resolves the Electrobun Resources layout beside Contents/MacOS", () => {
    const appRoot = path.resolve(path.sep, "Applications", "Eliza.app");
    const execPath = path.join(appRoot, "Contents", "MacOS", "bun");
    expect(resolvePackagedNativePermissionsDylib(execPath)).toBe(
      path.join(
        appRoot,
        "Contents",
        "Resources",
        "app",
        "libMacWindowEffects.dylib",
      ),
    );
  });

  it("returns an absolute dylib path for the running execPath", () => {
    const resolved = resolvePackagedNativePermissionsDylib();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(`${path.sep}libMacWindowEffects.dylib`)).toBe(
      true,
    );
  });
});

describe("resolveBundleId", () => {
  it("falls back to ai.elizaos.app when Info.plist is missing", () => {
    const execPath = fakeAppExec(makeTempRoot());
    expect(resolveBundleId(execPath)).toBe("ai.elizaos.app");
  });

  it("reads CFBundleIdentifier from Info.plist, including spaced markup", () => {
    const root = makeTempRoot();
    const execPath = fakeAppExec(root);
    writeFileSync(
      path.join(root, "Example.app", "Contents", "Info.plist"),
      [
        '<?xml version="1.0"?>',
        "<plist><dict>",
        "<key>  CFBundleIdentifier  </key>",
        "<string>  ai.elizaos.bridge-test  </string>",
        "</dict></plist>",
      ].join("\n"),
      "utf8",
    );
    expect(resolveBundleId(execPath)).toBe("ai.elizaos.bridge-test");
  });

  it("falls back when the plist has no CFBundleIdentifier string", () => {
    const root = makeTempRoot();
    const execPath = fakeAppExec(root);
    writeFileSync(
      path.join(root, "Example.app", "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleName</key><string>Eliza</string></dict></plist>",
      "utf8",
    );
    expect(resolveBundleId(execPath)).toBe("ai.elizaos.app");
  });

  it("falls back when Info.plist cannot be read as a file", () => {
    const root = makeTempRoot();
    const execPath = fakeAppExec(root);
    mkdirSync(path.join(root, "Example.app", "Contents", "Info.plist"));
    expect(resolveBundleId(execPath)).toBe("ai.elizaos.app");
  });

  it("falls back for the running unsigned bun executable", () => {
    expect(resolveBundleId()).toBe("ai.elizaos.app");
  });
});

describe("hasEmbeddedProvisioningEntitlement", () => {
  it("returns false when the embedded profile is missing", () => {
    const execPath = fakeAppExec(makeTempRoot());
    expect(
      hasEmbeddedProvisioningEntitlement(
        "com.apple.developer.healthkit",
        execPath,
      ),
    ).toBe(false);
  });

  it("detects a present entitlement and rejects a missing one", () => {
    const root = makeTempRoot();
    const execPath = fakeAppExec(root);
    writeFileSync(
      path.join(root, "Example.app", "Contents", "embedded.provisionprofile"),
      "payload com.apple.developer.healthkit extra",
      "utf8",
    );
    expect(
      hasEmbeddedProvisioningEntitlement(
        "com.apple.developer.healthkit",
        execPath,
      ),
    ).toBe(true);
    expect(
      hasEmbeddedProvisioningEntitlement(
        "com.apple.developer.family-controls",
        execPath,
      ),
    ).toBe(false);
  });

  it("returns false when the embedded profile cannot be read", () => {
    const root = makeTempRoot();
    const execPath = fakeAppExec(root);
    mkdirSync(
      path.join(root, "Example.app", "Contents", "embedded.provisionprofile"),
    );
    expect(
      hasEmbeddedProvisioningEntitlement(
        "com.apple.developer.healthkit",
        execPath,
      ),
    ).toBe(false);
  });
});

describe("runOsascript", () => {
  it("returns trimmed stdout for a successful snippet on Darwin", async () => {
    if (!IS_DARWIN) {
      expect(await runOsascript('return "hello"')).toBeNull();
      return;
    }
    expect(await runOsascript('return "  hello  "')).toBe("hello");
  });

  it("returns an empty string when the snippet succeeds with no text", async () => {
    if (!IS_DARWIN) {
      expect(await runOsascript("return")).toBeNull();
      return;
    }
    expect(await runOsascript("return")).toBe("");
  });

  it("returns null when osascript exits non-zero", async () => {
    expect(await runOsascript("error number 1")).toBeNull();
  });

  it("returns null when the process exceeds timeoutMs", async () => {
    if (!IS_DARWIN) {
      expect(await runOsascript("delay 2", 100)).toBeNull();
      return;
    }
    expect(await runOsascript("delay 2", 150)).toBeNull();
  });
});

describe("queryTccStatus", () => {
  it("returns null for a service/client pair that is not in TCC.db", async () => {
    await expect(
      queryTccStatus(
        "kTCCServiceElizaBridgeCoverageMissing",
        "ai.elizaos.bridge-coverage-missing",
      ),
    ).resolves.toBeNull();
  });

  it("does not throw when identifiers contain sqlite quote characters", async () => {
    await expect(
      queryTccStatus("kTCCServiceEliza'sBridge", "ai.elizaos.app'test"),
    ).resolves.toBeNull();
  });
});

describe("queryAppleEventsTccStatus", () => {
  it("returns null for a missing Apple Events target", async () => {
    await expect(
      queryAppleEventsTccStatus(
        "com.example.eliza.bridge-coverage-missing",
        "ai.elizaos.bridge-coverage-missing",
      ),
    ).resolves.toBeNull();
  });

  it("accepts the default sender bundle id without throwing", async () => {
    await expect(
      queryAppleEventsTccStatus("com.example.eliza.bridge-coverage-missing"),
    ).resolves.toBeNull();
  });

  it("does not throw when the target bundle id contains quotes", async () => {
    await expect(
      queryAppleEventsTccStatus("com.apple.finder's-cousin", "ai.elizaos.app"),
    ).resolves.toBeNull();
  });
});

describe("getNativeDylib", () => {
  it("returns null or a symbol table and caches that result", async () => {
    const first = await getNativeDylib();
    const second = await getNativeDylib();
    expect(second).toBe(first);
    if (first === null) {
      return;
    }
    expect(typeof first.checkAccessibilityPermission).toBe("function");
    expect(typeof first.checkScreenRecordingPermission).toBe("function");
    expect(typeof first.checkRemindersPermission).toBe("function");
    expect(typeof first.checkCalendarPermission).toBe("function");
    expect(typeof first.checkContactsPermission).toBe("function");
    expect(typeof first.checkLocationPermission).toBe("function");
    expect(typeof first.checkMicrophonePermission).toBe("function");
    expect(typeof first.checkCameraPermission).toBe("function");
    expect(typeof first.checkNotificationPermission).toBe("function");
  });
});

describe("non-Darwin short-circuit via isolated re-import", () => {
  it("skips osascript, TCC, dylib load, and privacy-pane open", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    try {
      // Cache-busting suffix is concatenated so tsc does not treat this as a
      // literal module path (TS2307). Vitest still loads a separate instance.
      const isolatedSpecifier = `./_bridge.ts${"?platform=linux"}`;
      const bridge = (await import(
        isolatedSpecifier
      )) as typeof import("./_bridge.ts");
      expect(bridge.IS_DARWIN).toBe(false);
      expect(bridge.PLATFORM).toBe("linux");
      expect(await bridge.runOsascript('return "hello"')).toBeNull();
      expect(
        await bridge.queryTccStatus("kTCCServiceCamera", "ai.elizaos.app"),
      ).toBeNull();
      expect(
        await bridge.queryAppleEventsTccStatus("com.apple.finder"),
      ).toBeNull();
      expect(await bridge.getNativeDylib()).toBeNull();
      await expect(bridge.openPrivacyPane("Camera")).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: original,
      });
    }
  });
});
