/**
 * Pure-JS tests for the iOS bridge contract, the AppIntent registry, and the
 * OCR provider chain. These do not exercise any Swift code — that is unverified
 * on this host and lives behind the on-device validation checklist in
 * `docs/IOS_CONSTRAINTS.md`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetOcrProvidersForTests,
  createIosVisionOcrProvider,
  findIosAppIntent,
  findIosAppIntentsForBundle,
  IOS_APP_GROUP_ID,
  IOS_APP_INTENT_BUNDLE_IDS,
  IOS_APP_INTENT_REGISTRY,
  IOS_NATIVE_X_CALLBACK_INTENT_IDS,
  IOS_BRIDGE_JS_NAME,
  isIosNativeXCallbackIntent,
  listIosAppIntents,
  listOcrProviders,
  REPLAYKIT_FOREGROUND_MAX_BUFFER,
  REPLAYKIT_FOREGROUND_MAX_SESSION_SEC,
  registerOcrProvider,
  selectOcrProvider,
  unregisterOcrProvider,
  type IntentSpec,
  type IosBridgeResult,
  type IosComputerUseBridge,
  type VisionOcrResult,
} from "../mobile/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
}

// ── Bridge constants ─────────────────────────────────────────────────────────

describe("iOS bridge constants", () => {
  it("uses the App Group id that matches App.entitlements", () => {
    expect(IOS_APP_GROUP_ID).toBe("group.ai.elizaos.app");
  });
  it("exposes the Capacitor plugin jsName", () => {
    expect(IOS_BRIDGE_JS_NAME).toBe("ComputerUse");
  });
  it("caps ReplayKit foreground buffering at 30 frames and 30 seconds", () => {
    expect(REPLAYKIT_FOREGROUND_MAX_BUFFER).toBe(30);
    expect(REPLAYKIT_FOREGROUND_MAX_SESSION_SEC).toBe(30);
  });
});

// ── AppIntent registry ───────────────────────────────────────────────────────

describe("iOS AppIntent registry", () => {
  it("covers all the apps WS9 requires", () => {
    expect(IOS_APP_INTENT_BUNDLE_IDS).toEqual(
      expect.arrayContaining([
        "com.apple.mobilemail",
        "com.apple.MobileSMS",
        "com.apple.mobilenotes",
        "com.apple.reminders",
        "com.apple.Music",
        "com.apple.Maps",
        "com.apple.mobilesafari",
      ]),
    );
  });

  it("returns frozen registry entries", () => {
    const registry = IOS_APP_INTENT_REGISTRY as Record<string, readonly IntentSpec[]>;
    for (const bundleId of IOS_APP_INTENT_BUNDLE_IDS) {
      expect(Array.isArray(registry[bundleId])).toBe(true);
      expect(registry[bundleId].length).toBeGreaterThan(0);
    }
  });

  it("each intent declares a stable id, displayName, and parameter list", () => {
    for (const intent of listIosAppIntents()) {
      expect(intent.id).toMatch(/^com\.apple\./);
      expect(intent.bundleId).toMatch(/^com\.apple\./);
      expect(intent.displayName.length).toBeGreaterThan(0);
      expect(intent.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(intent.parameters)).toBe(true);
      for (const param of intent.parameters) {
        expect(typeof param.name).toBe("string");
        expect(["string", "number", "boolean", "date", "url", "enum"]).toContain(
          param.type,
        );
        expect(typeof param.required).toBe("boolean");
        if (param.type === "enum") {
          expect(Array.isArray(param.enumValues)).toBe(true);
          expect(param.enumValues!.length).toBeGreaterThan(0);
        }
      }
      expect(["donated", "system"]).toContain(intent.source);
      expect([
        "native-x-callback",
        "shortcut-required",
        "catalog-only",
      ]).toContain(intent.invocationMode);
    }
  });

  it("intent ids are unique across all bundles", () => {
    const ids = listIosAppIntents().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findIosAppIntent finds a known native x-callback intent", () => {
    const intent = findIosAppIntent("com.apple.mobilemail.send-email");
    expect(intent).toBeDefined();
    expect(intent!.bundleId).toBe("com.apple.mobilemail");
    expect(intent!.invocationMode).toBe("native-x-callback");
    expect(intent!.parameters.find((p) => p.name === "to")).toBeDefined();
  });

  it("findIosAppIntent returns undefined for unknown ids", () => {
    expect(findIosAppIntent("com.example.does-not-exist")).toBeUndefined();
  });

  it("findIosAppIntentsForBundle returns only that bundle's intents", () => {
    const mail = findIosAppIntentsForBundle("com.apple.mobilemail");
    expect(mail.length).toBeGreaterThan(0);
    for (const intent of mail) {
      expect(intent.bundleId).toBe("com.apple.mobilemail");
    }
    expect(findIosAppIntentsForBundle("com.example.does-not-exist")).toEqual([]);
  });

  it("Maps directions intent declares the expected transport enum", () => {
    const maps = findIosAppIntent("com.apple.Maps.directions");
    expect(maps).toBeDefined();
    expect(maps!.invocationMode).toBe("native-x-callback");
    const transport = maps!.parameters.find((p) => p.name === "transport");
    expect(transport?.type).toBe("enum");
    expect(transport?.enumValues).toEqual(
      expect.arrayContaining(["driving", "walking", "transit", "cycling"]),
    );
  });

  it("declares exactly the Swift native x-callback invocation map", () => {
    expect(IOS_NATIVE_X_CALLBACK_INTENT_IDS).toEqual([
      "com.apple.mobilemail.send-email",
      "com.apple.MobileSMS.send-message",
      "com.apple.Maps.directions",
      "com.apple.mobilesafari.open-url",
    ]);
    const nativeIds = listIosAppIntents()
      .filter((intent) => intent.invocationMode === "native-x-callback")
      .map((intent) => intent.id);
    expect(nativeIds).toEqual([...IOS_NATIVE_X_CALLBACK_INTENT_IDS]);
    for (const id of IOS_NATIVE_X_CALLBACK_INTENT_IDS) {
      expect(isIosNativeXCallbackIntent(id)).toBe(true);
    }
    expect(isIosNativeXCallbackIntent("com.apple.mobilenotes.create-note")).toBe(
      false,
    );
  });

  it("marks catalog entries without Swift mappings as non-native", () => {
    const nonNativeIds = [
      "com.apple.mobilenotes.create-note",
      "com.apple.mobilenotes.append-to-note",
      "com.apple.mobilenotes.search-notes",
      "com.apple.reminders.add-reminder",
      "com.apple.reminders.list-reminders",
      "com.apple.Music.play",
      "com.apple.Music.pause",
      "com.apple.Music.next-track",
      "com.apple.Maps.search",
      "com.apple.mobilesafari.add-bookmark",
    ];
    for (const id of nonNativeIds) {
      const intent = findIosAppIntent(id);
      expect(intent).toBeDefined();
      expect(intent!.invocationMode).not.toBe("native-x-callback");
      expect(isIosNativeXCallbackIntent(id)).toBe(false);
    }
    expect(findIosAppIntent("com.apple.Maps.search")!.invocationMode).toBe(
      "catalog-only",
    );
  });

  it("intents with at least one parameter either declare a required one or are list/control verbs", () => {
    const listOrControlSuffixes = [".pause", ".next-track", ".list-reminders"];
    for (const intent of listIosAppIntents()) {
      const isListOrControl = listOrControlSuffixes.some((suffix) =>
        intent.id.endsWith(suffix),
      );
      if (isListOrControl) continue;
      if (intent.parameters.length === 0) continue;
      const required = intent.parameters.filter((p) => p.required);
      expect(required.length).toBeGreaterThan(0);
    }
  });
});

// ── Native source alignment ──────────────────────────────────────────────────

describe("iOS native AppIntent source alignment", () => {
  it("keeps the native x-callback switch aligned with the TS registry", () => {
    const swift = readRepoFile(
      "packages/app-core/platforms/ios/App/App/ComputerUseBridge.swift",
    );
    const nativeCases = Array.from(swift.matchAll(/case "([^"]+)":/g)).map(
      (match) => match[1],
    );

    expect(nativeCases).toEqual(
      expect.arrayContaining([...IOS_NATIVE_X_CALLBACK_INTENT_IDS]),
    );

    for (const intent of listIosAppIntents()) {
      const hasNativeCase = nativeCases.includes(intent.id);
      expect(hasNativeCase).toBe(
        isIosNativeXCallbackIntent(intent.id),
      );
    }
  });

  it("keeps AppIntent discovery local to the app instead of claiming cross-app enumeration", () => {
    const swift = readRepoFile(
      "packages/app-core/platforms/ios/App/App/ComputerUseBridge.swift",
    );

    expect(swift).toContain("import AppIntents");
    expect(swift).toContain("appIntentList");
    expect(swift).toContain("AppShortcutsProvider");
    expect(swift).toContain("iOS does not");
    expect(swift).toContain("static registry covers known");
  });

  it.todo("adds a first-party AppShortcutsProvider when Siri phrase donation lands");
});

// ── OCR provider chain ───────────────────────────────────────────────────────

function fakeBridge(
  visionImpl: (
    args: { imageBase64: string; options?: unknown },
  ) => Promise<IosBridgeResult<VisionOcrResult>>,
): IosComputerUseBridge {
  // Minimal mock: only `visionOcr` is exercised here.
  return {
    probe: () =>
      Promise.resolve({
        ok: true,
        data: {
          platform: "ios",
          osVersion: "26.1",
          capabilities: {
            replayKitForeground: true,
            broadcastExtension: false,
            visionOcr: true,
            appIntents: true,
            accessibilityRead: true,
            foundationModel: false,
          },
        },
      }),
    replayKitForegroundStart: () =>
      Promise.resolve({ ok: false, code: "internal_error", message: "stub" }),
    replayKitForegroundStop: () =>
      Promise.resolve({ ok: false, code: "internal_error", message: "stub" }),
    replayKitForegroundDrain: () =>
      Promise.resolve({ ok: false, code: "internal_error", message: "stub" }),
    broadcastExtensionHandshake: () =>
      Promise.resolve({ ok: false, code: "internal_error", message: "stub" }),
    visionOcr: visionImpl,
    appIntentList: () =>
      Promise.resolve({ ok: true, data: { intents: [] } }),
    appIntentInvoke: () =>
      Promise.resolve({ ok: false, code: "internal_error", message: "stub" }),
    accessibilitySnapshot: () =>
      Promise.resolve({ ok: false, code: "internal_error", message: "stub" }),
    foundationModelGenerate: () =>
      Promise.resolve({
        ok: false,
        code: "foundation_model_unavailable",
        message: "stub",
      }),
    memoryPressureProbe: () =>
      Promise.resolve({
        ok: true,
        data: {
          source: "ios-uikit",
          capturedAt: Date.now(),
          severity: 0,
          availableMb: 1024,
          broadcastActive: false,
        },
      }),
  };
}

describe("OCR provider chain", () => {
  beforeEach(() => {
    _resetOcrProvidersForTests();
  });

  it("selectOcrProvider throws when nothing is registered", () => {
    expect(() => selectOcrProvider()).toThrow(/No OCR provider available/);
  });

  it("listOcrProviders is sorted by priority descending", () => {
    registerOcrProvider({
      name: "low",
      priority: 10,
      available: () => true,
      recognize: async () => ({
        lines: [],
        fullText: "",
        elapsedMs: 0,
        providerName: "low",
        languagesUsed: [],
      }),
    });
    registerOcrProvider({
      name: "high",
      priority: 100,
      available: () => true,
      recognize: async () => ({
        lines: [],
        fullText: "",
        elapsedMs: 0,
        providerName: "high",
        languagesUsed: [],
      }),
    });
    const ordered = listOcrProviders().map((p) => p.name);
    expect(ordered).toEqual(["high", "low"]);
  });

  it("selectOcrProvider skips unavailable providers", () => {
    registerOcrProvider({
      name: "high-unavail",
      priority: 100,
      available: () => false,
      recognize: async () => {
        throw new Error("should not be called");
      },
    });
    registerOcrProvider({
      name: "low-avail",
      priority: 10,
      available: () => true,
      recognize: async () => ({
        lines: [],
        fullText: "",
        elapsedMs: 0,
        providerName: "low-avail",
        languagesUsed: [],
      }),
    });
    expect(selectOcrProvider().name).toBe("low-avail");
  });

  it("createIosVisionOcrProvider reports unavailable when bridge is null", () => {
    const provider = createIosVisionOcrProvider(() => null);
    expect(provider.available()).toBe(false);
  });

  it("createIosVisionOcrProvider passes through Vision results", async () => {
    const bridge = fakeBridge(async ({ imageBase64 }) => {
      expect(imageBase64).toBe("aGVsbG8="); // "hello"
      return {
        ok: true,
        data: {
          lines: [
            {
              text: "WS9 OCR SMOKE",
              confidence: 0.99,
              boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
            },
          ],
          fullText: "WS9 OCR SMOKE",
          elapsedMs: 42,
          languagesUsed: ["en-US"],
        },
      };
    });
    const provider = createIosVisionOcrProvider(() => bridge);
    expect(provider.available()).toBe(true);
    const result = await provider.recognize(
      { kind: "base64", data: "aGVsbG8=" },
      { recognitionLevel: "accurate", languages: ["en-US"] },
    );
    expect(result.fullText).toBe("WS9 OCR SMOKE");
    expect(result.lines).toHaveLength(1);
    expect(result.providerName).toBe("ios-apple-vision");
    expect(result.languagesUsed).toEqual(["en-US"]);
  });

  it("createIosVisionOcrProvider throws on bridge error", async () => {
    const bridge = fakeBridge(async () => ({
      ok: false,
      code: "permission_denied",
      message: "user said no",
    }));
    const provider = createIosVisionOcrProvider(() => bridge);
    await expect(
      provider.recognize({ kind: "base64", data: "aGVsbG8=" }),
    ).rejects.toThrow(/permission_denied/);
  });

  it("createIosVisionOcrProvider converts byte input to base64", async () => {
    let captured: string | undefined;
    const bridge = fakeBridge(async ({ imageBase64 }) => {
      captured = imageBase64;
      return {
        ok: true,
        data: {
          lines: [],
          fullText: "",
          elapsedMs: 1,
          languagesUsed: ["auto"],
        },
      };
    });
    const provider = createIosVisionOcrProvider(() => bridge);
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    await provider.recognize({ kind: "bytes", data: bytes });
    expect(captured).toBe("aGVsbG8=");
  });

  it("unregisterOcrProvider removes the provider", () => {
    registerOcrProvider({
      name: "temp",
      priority: 5,
      available: () => true,
      recognize: async () => ({
        lines: [],
        fullText: "",
        elapsedMs: 0,
        providerName: "temp",
        languagesUsed: [],
      }),
    });
    expect(listOcrProviders()).toHaveLength(1);
    unregisterOcrProvider("temp");
    expect(listOcrProviders()).toHaveLength(0);
  });
});

// ── Type contract sanity ─────────────────────────────────────────────────────

describe("Bridge type contract", () => {
  it("IosBridgeResult discriminates on ok flag", () => {
    const success: IosBridgeResult<number> = { ok: true, data: 7 };
    const failure: IosBridgeResult<number> = {
      ok: false,
      code: "internal_error",
      message: "x",
    };
    if (success.ok) {
      expect(success.data).toBe(7);
    } else {
      throw new Error("unreachable");
    }
    if (!failure.ok) {
      expect(failure.code).toBe("internal_error");
    } else {
      throw new Error("unreachable");
    }
  });
});
