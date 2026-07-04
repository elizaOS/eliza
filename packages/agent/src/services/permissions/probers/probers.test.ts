/**
 * Contract coverage for the permission prober set: exactly one prober per
 * centrally-owned PermissionId (plugin-provided ids like website-blocking are
 * excluded — #12660), PROBERS_BY_ID indexing, the required PermissionState shape, and
 * the native-status mapping tables (AV / notification / EventKit-Contacts
 * codes) plus embedded-provisioning entitlement detection. Also source-scans the
 * AppleScript- and native-dylib-backed probers to enforce that check() stays
 * read-only (no osascript prompts), and exercises real darwin vs non-darwin
 * behaviour through IS_DARWIN branches.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PERMISSION_IDS, type PermissionId } from "@elizaos/shared";
import { describe, expect, it } from "vitest";

import type { Prober } from "../contracts.ts";
import {
  hasEmbeddedProvisioningEntitlement,
  IS_DARWIN,
  mapAVAuthStatus,
  mapNativePrivacyAuthStatus,
  mapUNAuthStatus,
  platformUnsupportedState,
} from "./_bridge.ts";
import { ALL_PROBERS, PROBERS_BY_ID } from "./index.ts";

// Permission ids whose prober is contributed by an opt-in plugin at init
// (via registry.registerProber), NOT by the central ALL_PROBERS enumeration.
// `website-blocking` is provided by @elizaos/plugin-personal-assistant; the old
// central "granted" stub was removed in #12660, so it must be absent here.
// Future plugin-provided probers extend this list.
const PLUGIN_PROVIDED_PERMISSION_IDS: readonly PermissionId[] = [
  "website-blocking",
];

// The set the central enumeration is responsible for: every canonical id minus
// the plugin-provided ones.
const EXPECTED_IDS = PERMISSION_IDS.filter(
  (id) => !PLUGIN_PROVIDED_PERMISSION_IDS.includes(id),
);

describe("permission probers", () => {
  it("registers exactly one prober per centrally-owned PermissionId", () => {
    expect(ALL_PROBERS.length).toBe(EXPECTED_IDS.length);
    const ids = new Set(ALL_PROBERS.map((p) => p.id));
    for (const id of EXPECTED_IDS) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.size).toBe(EXPECTED_IDS.length);
  });

  it("does not centrally enumerate plugin-provided probers", () => {
    // Proves the old central website-blocking enumeration is gone (#12660):
    // its prober only appears once the owning plugin registers it at init.
    const ids = new Set(ALL_PROBERS.map((p) => p.id));
    for (const id of PLUGIN_PROVIDED_PERMISSION_IDS) {
      expect(ids.has(id)).toBe(false);
      expect(PROBERS_BY_ID.has(id)).toBe(false);
    }
    expect(ids.has("website-blocking")).toBe(false);
    expect(PROBERS_BY_ID.get("website-blocking")).toBeUndefined();
  });

  it("PROBERS_BY_ID indexes every centrally-owned prober", () => {
    for (const id of EXPECTED_IDS) {
      expect(PROBERS_BY_ID.get(id)).toBeDefined();
    }
  });

  it("each prober exposes a stable id, check(), and request()", () => {
    for (const prober of ALL_PROBERS) {
      expect(typeof prober.id).toBe("string");
      expect(typeof prober.check).toBe("function");
      expect(typeof prober.request).toBe("function");
    }
  });

  it("check() returns a PermissionState shape with required fields", async () => {
    // Pick the prober least likely to hit anything platform-specific.
    const shell = PROBERS_BY_ID.get("shell") as Prober;
    const state = await shell.check();
    expect(state.id).toBe("shell");
    expect(typeof state.status).toBe("string");
    expect(typeof state.lastChecked).toBe("number");
    expect(typeof state.canRequest).toBe("boolean");
    expect(["darwin", "win32", "linux"]).toContain(state.platform);
  });

  it("platformUnsupportedState produces the contract shape", () => {
    const state = platformUnsupportedState("notes");
    expect(state.id).toBe("notes");
    expect(state.status).toBe("not-applicable");
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.canRequest).toBe(false);
  });

  it("detects entitlements in an embedded provisioning profile", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "eliza-permission-prober-"),
    );
    try {
      const contents = path.join(root, "Example.app", "Contents");
      const macos = path.join(contents, "MacOS");
      const execPath = path.join(macos, "Example");
      mkdirSync(macos, { recursive: true });
      writeFileSync(
        path.join(contents, "embedded.provisionprofile"),
        "com.apple.developer.healthkit",
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps the native dylib camera/microphone status contract", () => {
    expect(mapAVAuthStatus(0)).toBe("not-determined");
    expect(mapAVAuthStatus(1)).toBe("denied");
    expect(mapAVAuthStatus(2)).toBe("granted");
    expect(mapAVAuthStatus(3)).toBe("restricted");
  });

  it("maps the native dylib notification status contract", () => {
    expect(mapUNAuthStatus(0)).toBe("not-determined");
    expect(mapUNAuthStatus(1)).toBe("denied");
    expect(mapUNAuthStatus(2)).toBe("granted");
    expect(mapUNAuthStatus(3)).toBe("restricted");
  });

  it("maps the native EventKit/Contacts status contract", () => {
    expect(mapNativePrivacyAuthStatus(0)).toBe("not-determined");
    expect(mapNativePrivacyAuthStatus(1)).toBe("denied");
    expect(mapNativePrivacyAuthStatus(2)).toBe("granted");
    expect(mapNativePrivacyAuthStatus(3)).toBe("restricted");
    expect(mapNativePrivacyAuthStatus(4)).toBe("restricted");
  });

  it("keeps AppleScript-backed check() paths read-only", () => {
    const files = ["automation.ts", "notes.ts"];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const checkStart = source.indexOf("async check()");
      const requestStart = source.indexOf("async request", checkStart);
      expect(checkStart, `${file} has check()`).toBeGreaterThanOrEqual(0);
      expect(requestStart, `${file} has request()`).toBeGreaterThan(checkStart);
      const checkBody = source.slice(checkStart, requestStart);
      expect(
        checkBody,
        `${file} check() must not prompt via osascript`,
      ).not.toContain("runOsascript");
      expect(source, `${file} should use TCC reads`).toContain(
        "queryAppleEventsTccStatus",
      );
    }
  });

  it("keeps native Apple data probers off Automation", () => {
    const files = ["calendar.ts", "contacts.ts", "reminders.ts"];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const checkStart = source.indexOf("async check()");
      const requestStart = source.indexOf("async request", checkStart);
      expect(checkStart, `${file} has check()`).toBeGreaterThanOrEqual(0);
      expect(requestStart, `${file} has request()`).toBeGreaterThan(checkStart);
      expect(source, `${file} should use native probes`).toContain(
        "getNativeDylib",
      );
      expect(source, `${file} must not probe Apple Events`).not.toContain(
        "queryAppleEventsTccStatus",
      );
      expect(source, `${file} must not prompt via osascript`).not.toContain(
        "runOsascript",
      );
    }
  });

  it("non-darwin: macOS-only probers short-circuit to not-applicable", async () => {
    if (IS_DARWIN) return; // skip on macOS
    const macOnly: PermissionId[] = [
      "accessibility",
      "app-blocking",
      "automation",
      "battery-optimization",
      "bluetooth",
      "calendar",
      "contacts",
      "full-disk",
      "health",
      "local-network",
      "messages",
      "notes",
      "overlay",
      "phone",
      "photos",
      "reminders",
      "screen-recording",
      "screentime",
      "speech-recognition",
      "usage-access",
      "wifi",
      "write-settings",
    ];
    for (const id of macOnly) {
      const prober = PROBERS_BY_ID.get(id) as Prober;
      const state = await prober.check();
      expect(state.status).toBe("not-applicable");
      expect(state.restrictedReason).toBe("platform_unsupported");
    }
  });

  it("darwin: health and screentime report restricted/entitlement_required in unsigned dev", async () => {
    if (!IS_DARWIN) return; // skip off macOS
    // In unsigned dev there is no embedded provisioning profile, so the
    // entitlement check returns false. If this test is ever run inside a
    // signed bundle the assertion needs to be relaxed.
    const health = PROBERS_BY_ID.get("health") as Prober;
    const screentime = PROBERS_BY_ID.get("screentime") as Prober;
    const healthState = await health.check();
    const screentimeState = await screentime.check();
    // Either restricted (unsigned dev) or not-determined (signed with entitlement).
    expect(["restricted", "not-determined"]).toContain(healthState.status);
    expect(["restricted", "not-determined"]).toContain(screentimeState.status);
    if (healthState.status === "restricted") {
      expect(healthState.restrictedReason).toBe("entitlement_required");
    }
    if (screentimeState.status === "restricted") {
      expect(screentimeState.restrictedReason).toBe("entitlement_required");
    }
  });
});
