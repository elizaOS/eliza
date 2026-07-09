/**
 * Verifies the generated Android cloud activity preserves native guards that
 * are required after local-runtime sources are stripped from the build.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudSafeMainActivityJava } from "./run-mobile-build.mjs";

describe("cloudSafeMainActivityJava", () => {
  it("registers the Firebase-safe push plugin after Capacitor creates the bridge", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");
    const bridgeCreation = source.indexOf(
      "super.onCreate(savedInstanceState);",
    );
    const safeRegistration = source.indexOf(
      "getBridge().registerPlugin(SafePushNotificationsPlugin.class);",
    );

    assert.ok(bridgeCreation >= 0);
    assert.ok(safeRegistration > bridgeCreation);
  });
});
