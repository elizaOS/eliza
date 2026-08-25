/** Verifies the privileged AOSP APK strips Google telemetry/ML SDK surfaces. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANDROID_SYSTEM_REQUIRED_NATIVE_PLUGIN_PACKAGES,
  ANDROID_SYSTEM_STRIPPED_NATIVE_PLUGINS,
  findAndroidSystemPluginManifestFindings,
  findAndroidSystemTelemetryFindings,
} from "./run-mobile-build.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const androidAppDir = path.resolve(scriptsDir, "../platforms/android/app");

describe("Android system telemetry stripping", () => {
  it("removes only the Google-backed native modules from the AOSP lane", () => {
    expect(ANDROID_SYSTEM_STRIPPED_NATIVE_PLUGINS).toEqual([
      ["@capacitor/barcode-scanner", "capacitor-barcode-scanner"],
      ["@capacitor/push-notifications", "capacitor-push-notifications"],
      ["@elizaos/capacitor-mlkit-text", "elizaos-capacitor-mlkit-text"],
    ]);
  });

  it("accepts clean artifact evidence", () => {
    expect(
      findAndroidSystemTelemetryFindings({
        dependencyText: 'groupId: "androidx.core"',
        dexBuffers: [Buffer.from("ai/elizaos/app/AgentPlugin")],
        entries: ["classes.dex", "assets/agent/agent.mjs"],
        manifestText: "ai.elizaos.app.ElizaAgentService",
      }),
    ).toEqual([]);
  });

  it("rejects manifest, archive, DEX, and dependency evidence", () => {
    const findings = findAndroidSystemTelemetryFindings({
      dependencyText: 'groupId: "com.google.mlkit"',
      dexBuffers: [
        Buffer.from(
          "com/google/android/datatransport/runtime ai/elizaos/app/SafePushNotificationsPlugin",
        ),
      ],
      entries: [
        "assets/mlkit-google-ocr-models/model.bin",
        "vision-interfaces.properties",
      ],
      manifestText:
        "com.google.firebase.components.ComponentDiscoveryService com.google.android.c2dm.permission.RECEIVE",
    });

    expect(findings).toContain("manifest marker: com.google.firebase.");
    expect(findings).toContain("manifest marker: com.google.android.c2dm.");
    expect(findings).toContain(
      "APK entry: assets/mlkit-google-ocr-models/model.bin",
    );
    expect(findings).toContain("APK entry: vision-interfaces.properties");
    expect(findings).toContain("DEX marker: com/google/android/datatransport/");
    expect(findings).toContain(
      "DEX marker: ai/elizaos/app/SafePushNotificationsPlugin",
    );
    expect(findings).toContain("SDK dependency group: com.google.mlkit");
  });

  it("keeps push source buildable elsewhere without linking it into AOSP", () => {
    const gradle = fs.readFileSync(
      path.join(androidAppDir, "build.gradle"),
      "utf8",
    );
    const proguardRules = fs.readFileSync(
      path.join(androidAppDir, "proguard-rules.pro"),
      "utf8",
    );
    const mainActivity = fs.readFileSync(
      path.join(
        androidAppDir,
        "src/main/java/ai/elizaos/app/MainActivity.java",
      ),
      "utf8",
    );

    expect(gradle).toContain(
      "project.findProperty('elizaCloudBuild') != 'true' && project.findProperty('elizaAospBuild') != 'true'",
    );
    expect(gradle).toContain("tasks.withType(JavaCompile).configureEach");
    expect(gradle).toContain("exclude '**/SafePushNotificationsPlugin.java'");
    expect(proguardRules).toMatch(
      /-if\s+class\s+com\.google\.firebase\.FirebaseApp\s*\n\s*-keep\s+class\s+com\.google\.firebase\.\*\*/m,
    );
    expect(mainActivity).not.toContain("SafePushNotificationsPlugin.class");
    expect(mainActivity).toContain("BuildConfig.AOSP_BUILD");
    expect(mainActivity).toContain(
      '.forName(getPackageName() + ".SafePushNotificationsPlugin")',
    );
  });

  it("requires the packaged local-runtime plugins and rejects stale Google modules", () => {
    const cleanPlugins = ANDROID_SYSTEM_REQUIRED_NATIVE_PLUGIN_PACKAGES.map(
      (pkg) => ({ pkg }),
    );
    expect(
      findAndroidSystemPluginManifestFindings(JSON.stringify(cleanPlugins)),
    ).toEqual([]);

    const findings = findAndroidSystemPluginManifestFindings(
      JSON.stringify([
        ...cleanPlugins.filter(
          (plugin) => plugin.pkg !== "@elizaos/capacitor-bun-runtime",
        ),
        { pkg: "@capacitor/push-notifications" },
      ]),
    );
    expect(findings).toContain(
      "required native plugin is missing: @elizaos/capacitor-bun-runtime",
    );
    expect(findings).toContain(
      "stripped native plugin remains packaged: @capacitor/push-notifications",
    );
  });
});
