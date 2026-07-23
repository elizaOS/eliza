/**
 * Verifies the generated Android cloud activity preserves native guards that
 * are required after local-runtime sources are stripped from the build.
 */
import { describe, expect, it } from "vitest";
import { cloudSafeMainActivityJava } from "./run-mobile-build.mjs";

describe("cloudSafeMainActivityJava", () => {
  it("installs the splash lifecycle before Capacitor creates the bridge", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");
    const splashInstall = source.indexOf(
      "SplashScreen.installSplashScreen(this);",
    );
    const bridgeCreation = source.indexOf(
      "super.onCreate(savedInstanceState);",
    );

    expect(source).toContain("import androidx.core.splashscreen.SplashScreen;");
    expect(splashInstall).toBeGreaterThanOrEqual(0);
    expect(splashInstall).toBeLessThan(bridgeCreation);
  });

  it("registers the Firebase-safe push plugin after Capacitor creates the bridge", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");
    const bridgeCreation = source.indexOf(
      "super.onCreate(savedInstanceState);",
    );
    const safeRegistration = source.indexOf(
      "getBridge().registerPlugin(SafePushNotificationsPlugin.class);",
    );

    expect(bridgeCreation).toBeGreaterThanOrEqual(0);
    expect(safeRegistration).toBeGreaterThan(bridgeCreation);
  });
});
