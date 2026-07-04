/**
 * Native build infrastructure tests verify that each facewear platform scaffold
 * and emulator workspace can be found and parsed.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const nativeRoot = resolve(root, "native");
const questRoot = resolve(nativeRoot, "android/quest");
const xrealRoot = resolve(nativeRoot, "android/xreal");
const evenRealitiesRoot = resolve(nativeRoot, "android/even-realities");
const visionosRoot = resolve(nativeRoot, "visionos/ElizaFacewear");
const emulatorRoot = resolve(root, "emulator");

describe("native build infrastructure", () => {
  describe("Quest Bubblewrap config", () => {
    it("bubblewrap.json exists and is valid JSON", () => {
      const path = resolve(questRoot, "bubblewrap.json");
      expect(existsSync(path)).toBe(true);
      const raw = readFileSync(path, "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("bubblewrap.json has required fields: packageId, host, startUrl, display", () => {
      const path = resolve(questRoot, "bubblewrap.json");
      const config = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(config.packageId).toBeTruthy();
      expect(config.host).toBeTruthy();
      expect(config.startUrl).toBeTruthy();
      expect(config.display).toBeTruthy();
    });
  });

  describe("XReal Gradle files", () => {
    it("gradlew exists", () => {
      expect(existsSync(resolve(xrealRoot, "gradlew"))).toBe(true);
    });

    it("Gradle wrapper jar and version catalog exist", () => {
      expect(
        existsSync(resolve(xrealRoot, "gradle/wrapper/gradle-wrapper.jar")),
      ).toBe(true);
      expect(existsSync(resolve(xrealRoot, "gradle/libs.versions.toml"))).toBe(
        true,
      );
    });

    it("settings.gradle.kts exists", () => {
      expect(existsSync(resolve(xrealRoot, "settings.gradle.kts"))).toBe(true);
    });

    it("app/build.gradle.kts exists", () => {
      expect(existsSync(resolve(xrealRoot, "app/build.gradle.kts"))).toBe(true);
    });

    it("AndroidManifest.xml exists", () => {
      expect(
        existsSync(resolve(xrealRoot, "app/src/main/AndroidManifest.xml")),
      ).toBe(true);
    });
  });

  describe("Even Realities Android Gradle files", () => {
    it("Gradle wrapper, settings, version catalog, and app build files exist", () => {
      expect(existsSync(resolve(evenRealitiesRoot, "gradlew"))).toBe(true);
      expect(
        existsSync(
          resolve(evenRealitiesRoot, "gradle/wrapper/gradle-wrapper.jar"),
        ),
      ).toBe(true);
      expect(
        existsSync(resolve(evenRealitiesRoot, "gradle/libs.versions.toml")),
      ).toBe(true);
      expect(
        existsSync(resolve(evenRealitiesRoot, "settings.gradle.kts")),
      ).toBe(true);
      expect(
        existsSync(resolve(evenRealitiesRoot, "app/build.gradle.kts")),
      ).toBe(true);
      expect(
        existsSync(
          resolve(evenRealitiesRoot, "app/src/main/AndroidManifest.xml"),
        ),
      ).toBe(true);
    });

    it("Kotlin bridge sources are present and not placeholders", () => {
      const base = resolve(
        evenRealitiesRoot,
        "app/src/main/java/com/elizaos/facewear/evenrealities",
      );
      const g1 = readFileSync(resolve(base, "G1BleService.kt"), "utf-8");
      const bridge = readFileSync(
        resolve(base, "AgentBridgeService.kt"),
        "utf-8",
      );
      expect(g1).toContain("GlassSide.LEFT");
      expect(g1).toContain("GlassSide.RIGHT");
      expect(g1).toContain("cmdOpenMic = 0x0E");
      expect(bridge).toContain('"mic_lc3"');
      expect(bridge).not.toContain("not yet forwarded");
    });
  });

  describe("XReal Kotlin sources", () => {
    const ktBase = resolve(
      xrealRoot,
      "app/src/main/java/com/elizaos/facewear/xreal",
    );

    it("MainActivity.kt exists", () => {
      expect(existsSync(resolve(ktBase, "MainActivity.kt"))).toBe(true);
    });

    it("XrealBridgeJs.kt exists", () => {
      expect(existsSync(resolve(ktBase, "XrealBridgeJs.kt"))).toBe(true);
    });

    it("CameraService.kt exists", () => {
      expect(existsSync(resolve(ktBase, "CameraService.kt"))).toBe(true);
    });
  });

  describe("visionOS Swift files", () => {
    it("App.swift exists", () => {
      expect(existsSync(resolve(visionosRoot, "App.swift"))).toBe(true);
    });

    it("AgentConnection.swift exists", () => {
      expect(existsSync(resolve(visionosRoot, "AgentConnection.swift"))).toBe(
        true,
      );
    });

    it("ConnectionConfig.swift exists", () => {
      expect(existsSync(resolve(visionosRoot, "ConnectionConfig.swift"))).toBe(
        true,
      );
    });

    it("ContentView.swift exists", () => {
      expect(existsSync(resolve(visionosRoot, "ContentView.swift"))).toBe(true);
    });

    it("ConnectionConfig.swift has defaultAgentWsUrl", () => {
      const path = resolve(visionosRoot, "ConnectionConfig.swift");
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("defaultAgentWsUrl");
      expect(content).toContain("ws://localhost:31338");
    });
  });

  describe("CLI emulator", () => {
    it("emulator/src/cli.ts source exists", () => {
      expect(existsSync(resolve(emulatorRoot, "src/cli.ts"))).toBe(true);
    });

    it("emulator/dist/emulator.js build artifact exists", () => {
      expect(existsSync(resolve(emulatorRoot, "dist/emulator.js"))).toBe(true);
    });
  });
});
