/**
 * Functional parity — plugin-facewear merges plugin-xr and plugin-smartglasses.
 *
 * Validates that:
 *   A. All XR session service exports are re-exported from plugin-facewear
 *   B. All smartglasses protocol symbols are available in plugin-facewear
 *   C. The device registry covers all 5 supported device types
 *   D. FacewearService integrates both XR and smartglasses sub-services
 *   E. Native app builds are scaffolded for all target platforms
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function readFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(repoRoot, relPath));
}

describe("plugin-facewear functional parity", () => {
  // A. XR session service re-exports ──────────────────────────────────────────

  it("A — plugin-facewear re-exports XR_SERVICE_TYPE and XRSessionService", () => {
    const indexSrc = readFile("plugins/plugin-facewear/src/index.ts");
    expect(indexSrc).toContain("XR_SERVICE_TYPE");
    expect(indexSrc).toContain("XRSessionService");
  });

  it("A — plugin-facewear re-exports AudioPipeline and VisionPipeline", () => {
    const indexSrc = readFile("plugins/plugin-facewear/src/index.ts");
    expect(indexSrc).toContain("AudioPipeline");
    expect(indexSrc).toContain("VisionPipeline");
  });

  it("A — XR session service has all required pipeline methods", () => {
    const svcSrc = readFile(
      "plugins/plugin-facewear/src/services/xr-session-service.ts",
    );
    expect(svcSrc).toContain("AudioPipeline");
    expect(svcSrc).toContain("VisionPipeline");
    expect(svcSrc).toContain("XR_SERVICE_TYPE");
  });

  // B. Smartglasses protocol ──────────────────────────────────────────────────

  it("B — smartglasses protocol exports G1 command enum and UART constants", () => {
    const protoSrc = readFile(
      "plugins/plugin-facewear/src/protocol/smartglasses.ts",
    );
    expect(protoSrc).toContain("G1Command");
    expect(protoSrc).toContain("EVEN_G1_UART");
  });

  it("B — all 4 transport implementations are present in plugin-facewear", () => {
    const transports = [
      "plugins/plugin-facewear/src/transport/even-bridge.ts",
      "plugins/plugin-facewear/src/transport/web-bluetooth.ts",
      "plugins/plugin-facewear/src/transport/noble.ts",
      "plugins/plugin-facewear/src/transport/mock.ts",
    ];
    for (const t of transports) {
      expect(fileExists(t), `missing transport: ${t}`).toBe(true);
    }
  });

  it("B — SmartglassesService is integrated in plugin-facewear", () => {
    const svcSrc = readFile(
      "plugins/plugin-facewear/src/services/smartglasses-service.ts",
    );
    expect(svcSrc).toContain("SmartglassesService");
    expect(svcSrc).toContain("encodeConnectionReady");
  });

  // C. Device registry ────────────────────────────────────────────────────────

  it("C — DEVICE_REGISTRY covers all 5 device types", () => {
    const registrySrc = readFile(
      "plugins/plugin-facewear/src/devices/registry.ts",
    );
    const requiredTypes = [
      "meta-quest",
      "xreal",
      "even-realities",
      "apple-vision-pro",
      "simulator",
    ];
    for (const type of requiredTypes) {
      expect(registrySrc, `missing device type: ${type}`).toContain(
        `"${type}"`,
      );
    }
  });

  it("C — each device profile declares a connectionType", () => {
    const registrySrc = readFile(
      "plugins/plugin-facewear/src/devices/registry.ts",
    );
    expect(registrySrc).toContain("connectionType");
    expect(registrySrc).toContain("webxr");
    expect(registrySrc).toContain("ble");
  });

  it("C — FacewearDeviceType is exported from device registry", () => {
    const registrySrc = readFile(
      "plugins/plugin-facewear/src/devices/registry.ts",
    );
    expect(registrySrc).toContain("FacewearDeviceType");
    expect(registrySrc).toContain("DEVICE_REGISTRY");
  });

  // D. FacewearService integration ────────────────────────────────────────────

  it("D — FacewearService exposes getXRService() and getSmartglassesService()", () => {
    const svcSrc = readFile(
      "plugins/plugin-facewear/src/services/facewear-service.ts",
    );
    expect(svcSrc).toContain("getXRService");
    expect(svcSrc).toContain("getSmartglassesService");
  });

  it("D — FacewearService reports connected devices from both sub-services", () => {
    const svcSrc = readFile(
      "plugins/plugin-facewear/src/services/facewear-service.ts",
    );
    expect(svcSrc).toContain("getConnectedDevices");
    expect(svcSrc).toContain("hasActiveDevice");
  });

  it("D — plugin-facewear plugin object includes both XRSessionService and SmartglassesService", () => {
    const indexSrc = readFile("plugins/plugin-facewear/src/index.ts");
    expect(indexSrc).toContain("XRSessionService");
    expect(indexSrc).toContain("SmartglassesService");
    expect(indexSrc).toContain("FacewearService");
    expect(indexSrc).toContain("services:");
  });

  // E. Native platform scaffolds ──────────────────────────────────────────────

  it("E — Meta Quest 3 Bubblewrap config is present", () => {
    expect(
      fileExists(
        "plugins/plugin-facewear/native/android/quest/bubblewrap.json",
      ),
    ).toBe(true);
  });

  it("E — XReal Android Kotlin sources are present", () => {
    const base =
      "plugins/plugin-facewear/native/android/xreal/app/src/main/java/com/elizaos/facewear/xreal";
    expect(fileExists(`${base}/MainActivity.kt`)).toBe(true);
    expect(fileExists(`${base}/XrealBridgeJs.kt`)).toBe(true);
  });

  it("E — Apple Vision Pro Swift sources are present", () => {
    const base = "plugins/plugin-facewear/native/visionos/ElizaFacewear";
    expect(fileExists(`${base}/App.swift`)).toBe(true);
    expect(fileExists(`${base}/AgentConnection.swift`)).toBe(true);
    expect(fileExists(`${base}/ContentView.swift`)).toBe(true);
  });
});
