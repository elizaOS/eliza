/** Locks the standard Google Play Android client to its minimal manifest. */
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { assertAndroidPlayManifestPolicyEvidence } from "./lib/android-cloud-artifact-audit.mjs";
import {
  ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES,
  ANDROID_CLOUD_STRIPPED_COMPONENTS,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_PERMISSIONS,
  ANDROID_CLOUD_STRIPPED_RESOURCE_FILES,
  ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES,
  ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES,
  androidPlayManifestEvidenceFromAapt,
  createAndroidPlayManifestPolicy,
  findAndroidPlayIndexHtmlFindings,
  findAndroidPlayTextAssetFindings,
} from "./run-mobile-build.mjs";

const VARIABLES_GRADLE = fs.readFileSync(
  new URL("../platforms/android/variables.gradle", import.meta.url),
  "utf8",
);
const APP_BUILD_GRADLE = fs.readFileSync(
  new URL("../platforms/android/app/build.gradle", import.meta.url),
  "utf8",
);
const APP_MAIN_SOURCE = fs.readFileSync(
  new URL("../../app/src/main.tsx", import.meta.url),
  "utf8",
);

const AAPT_MANIFEST = `
  E: manifest (line=2)
    E: uses-sdk (line=3)
      A: android:targetSdkVersion(0x01010270)=(type 0x10)0x24
    E: queries (line=4)
      E: intent (line=5)
        E: action (line=6)
          A: android:name(0x01010003)="android.speech.RecognitionService" (Raw: "android.speech.RecognitionService")
    E: uses-permission (line=7)
      A: android:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
    E: application (line=8)
      A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff
      A: android:allowBackup(0x01010280)=(type 0x12)0x0
      A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0
      E: activity (line=9)
        A: android:name(0x01010003)="ai.elizaos.app.MainActivity" (Raw: "ai.elizaos.app.MainActivity")
        E: intent-filter (line=10)
          E: action (line=11)
            A: android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
      E: provider (line=12)
        A: android:name(0x01010003)="androidx.core.content.FileProvider" (Raw: "androidx.core.content.FileProvider")
        E: meta-data (line=13)
          A: android:name(0x01010003)="android.support.FILE_PROVIDER_PATHS" (Raw: "android.support.FILE_PROVIDER_PATHS")
`;

describe("Android Play manifest policy", () => {
  it("parses AAPT xmltree evidence without confusing nested action names for components", () => {
    expect(androidPlayManifestEvidenceFromAapt(AAPT_MANIFEST)).toEqual({
      actions: [
        "android.intent.action.MAIN",
        "android.speech.RecognitionService",
      ],
      application: {
        allowBackup: "false",
        debuggable: "true",
        usesCleartextTraffic: "false",
      },
      components: [
        "activity:ai.elizaos.app.MainActivity",
        "provider:androidx.core.content.FileProvider",
      ],
      metadataNames: ["android.support.FILE_PROVIDER_PATHS"],
      permissions: ["android.permission.INTERNET"],
      queryActions: ["android.speech.RecognitionService"],
      queryPackages: [],
      targetSdkVersion: "36",
    });
  });

  it("accepts only the exact release policy evidence", () => {
    const policy = createAndroidPlayManifestPolicy();
    expect(() =>
      assertAndroidPlayManifestPolicyEvidence(
        {
          ...policy,
          application: { ...policy.application },
        },
        policy,
      ),
    ).not.toThrow();
  });

  it("rejects an unexpected restricted permission or background service", () => {
    const policy = createAndroidPlayManifestPolicy();
    expect(() =>
      assertAndroidPlayManifestPolicyEvidence(
        {
          ...policy,
          application: { ...policy.application },
          components: [
            ...policy.components,
            "service:ai.elizaos.app.GatewayConnectionService",
          ],
          permissions: [...policy.permissions, "android.permission.CAMERA"],
        },
        policy,
      ),
    ).toThrow(
      /unexpected component.*GatewayConnectionService[\s\S]*unexpected permission.*CAMERA/,
    );
  });

  it("keeps policy-hostile surfaces in the strip set and native code out", () => {
    for (const component of [
      "ElizaAccessibilityService",
      "ElizaNotificationListenerService",
      "ElizaVoiceInputMethodService",
      "GatewayConnectionService",
    ]) {
      expect(ANDROID_CLOUD_STRIPPED_COMPONENTS).toContain(component);
    }
    for (const permission of [
      "BIND_ACCESSIBILITY_SERVICE",
      "BIND_NOTIFICATION_LISTENER_SERVICE",
      "CALL_PHONE",
      "CAMERA",
      "POST_NOTIFICATIONS",
      "READ_SMS",
      "SYSTEM_ALERT_WINDOW",
    ]) {
      expect(ANDROID_CLOUD_STRIPPED_PERMISSIONS).toContain(permission);
    }
    expect(ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES).toEqual([]);
    expect(ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES).toEqual([
      "agent",
      "runners",
    ]);
    expect(ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES).toEqual([
      "@capacitor/app",
      "@capacitor/browser",
      "@capacitor/device",
      "@capacitor/filesystem",
      "@capacitor/keyboard",
      "@capacitor/network",
      "@capacitor/preferences",
      "@capacitor/share",
      "@capacitor/status-bar",
      "@elizaos/capacitor-browser-surface",
      "@elizaos/capacitor-secure-store",
    ]);
    expect(ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS.map(([pkg]) => pkg)).toEqual(
      expect.arrayContaining([
        "@capacitor/background-runner",
        "@capacitor/push-notifications",
        "@elizaos/capacitor-bun-runtime",
        "@elizaos/capacitor-mobile-signals",
        "@elizaos/capacitor-screencapture",
        "@elizaos/capacitor-talkmode",
        "llama-cpp-capacitor",
      ]),
    );
    expect(
      ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS.map(([pkg]) => pkg),
    ).not.toContain("@elizaos/capacitor-browser-surface");
    expect(ANDROID_CLOUD_STRIPPED_RESOURCE_FILES).toEqual(
      expect.arrayContaining([
        "drawable/eliza_ime_mic_bg.xml",
        "drawable/ic_eliza_ime_keyboard.xml",
        "drawable/ic_eliza_ime_mic.xml",
        "drawable/ic_eliza_ime_open.xml",
        "layout/eliza_voice_ime.xml",
        "xml/eliza_accessibility_service.xml",
        "xml/method.xml",
      ]),
    );
    expect(ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES).toMatchObject({
      "values/android_app_actions.xml": [
        "app_widget_quick_actions_description",
        "app_widget_quick_actions_title",
      ],
      "values/strings.xml": expect.arrayContaining([
        "assistant_session_prompt",
        "eliza_ime_label",
        "eliza_ime_permission_needed",
      ]),
    });
  });

  it("targets API 36 and excludes background-worker dependencies in Cloud", () => {
    expect(VARIABLES_GRADLE).toContain("targetSdkVersion = 36");
    expect(APP_BUILD_GRADLE).toContain(
      "project.findProperty('elizaCloudBuild') != 'true'",
    );
    expect(APP_BUILD_GRADLE).toContain(
      'implementation "androidx.work:work-runtime:2.11.0"',
    );
  });

  it("rejects local routing and credential material in packaged text assets", () => {
    expect(
      findAndroidPlayTextAssetFindings(
        ["base/assets/public/app.js"],
        [Buffer.from("http://127.0.0.1:31337")],
      ),
    ).toEqual(["base/assets/public/app.js: local routing marker 31337"]);
    expect(
      findAndroidPlayTextAssetFindings(
        ["assets/public/app.js"],
        [Buffer.from('CEREBRAS_API_KEY="not-a-real-key"')],
      ),
    ).toEqual([]);
    expect(
      findAndroidPlayTextAssetFindings(
        ["assets/public/app.js"],
        [Buffer.from(`CARTESIA_API_KEY="${"a".repeat(24)}"`)],
      ),
    ).toEqual(["assets/public/app.js: Cerebras/Cartesia credential"]);
  });

  it("rejects an active local-agent bootstrap in packaged Play index HTML", () => {
    expect(
      findAndroidPlayIndexHtmlFindings(
        ["base/assets/public/index.html", "base/assets/public/assets/app.js"],
        [
          Buffer.from(
            "connect-src eliza-local-agent:; window.__ELIZA_ANDROID_IPC_FETCH_BRIDGE__ = true;",
          ),
          Buffer.from("eliza-local-agent: remains inert in a lazy chunk"),
        ],
      ),
    ).toEqual([
      "base/assets/public/index.html: active local bootstrap marker __ELIZA_ANDROID_IPC_FETCH_BRIDGE__",
      "base/assets/public/index.html: active local bootstrap marker eliza-local-agent:",
    ]);
  });

  it("does not initialize Android local-agent bridges in the Cloud client", () => {
    expect(APP_MAIN_SOURCE).toContain(
      "if (!isAndroidCloudBuild() && !hasFirstRunRuntimeOverride())",
    );
    expect(APP_MAIN_SOURCE).toContain(
      "if (!isAndroidCloudBuild()) {\n      installAndroidNativeAgentFetchBridge();",
    );
  });
});
