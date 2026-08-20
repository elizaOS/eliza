/**
 * Proves that LP3 color persistence is an explicit direct-build delta and that
 * ordinary Cloud/Play transforms remove every component and permission.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  hasAndroidPermissionRequest,
  removeAndroidPermissionRequests,
  removeApplicationComponentClassBlock,
} from "./mobile/android-manifest.mjs";
import {
  ANDROID_CLOUD_STRIPPED_COMPONENTS,
  ANDROID_CLOUD_STRIPPED_JAVA_FILES,
  ANDROID_CLOUD_STRIPPED_PERMISSIONS,
  ANDROID_LP3_COLOR_POLICY_ACTIONS,
  ANDROID_LP3_COLOR_POLICY_COMMAND_ACTIONS,
  ANDROID_LP3_COLOR_POLICY_COMPONENTS,
  ANDROID_LP3_COLOR_POLICY_JAVA_FILES,
  ANDROID_LP3_COLOR_POLICY_PERMISSIONS,
  ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS,
  enforceAndroidLp3ColorPolicyBuildPolicy,
  isAndroidLp3ColorPolicyEnabled,
  resolveAndroidCloudStripPolicy,
  resolveAndroidLp3ColorPolicyBuildEnv,
} from "./run-mobile-build.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const mobileBuildScriptPath = path.join(scriptsDir, "run-mobile-build.mjs");
const androidRoot = path.resolve(scriptsDir, "../platforms/android");
const manifestPath = path.join(androidRoot, "app/src/main/AndroidManifest.xml");
const gradlePath = path.join(androidRoot, "app/build.gradle");
const debugManifestPath = path.join(
  androidRoot,
  "lp3-color-policy/src/debug/AndroidManifest.xml",
);
const usbNetworkSecurityConfigPath = path.join(
  androidRoot,
  "lp3-color-policy/src/debug/res/xml/lp3_usb_network_security_config.xml",
);
const servicePath = path.join(
  androidRoot,
  "lp3-color-policy/src/debug/java/ai/elizaos/app/Lp3ColorPolicyService.java",
);
const initializerPath = path.join(
  androidRoot,
  "lp3-color-policy/src/debug/java/ai/elizaos/app/Lp3ColorPolicyInitializer.java",
);
const readmePath = path.join(androidRoot, "README.md");
const repoRoot = path.resolve(scriptsDir, "../../..");

function stripManifest(xml, policy) {
  let stripped = xml;
  for (const component of policy.components) {
    stripped = removeApplicationComponentClassBlock(stripped, component);
  }
  return removeAndroidPermissionRequests(stripped, policy.permissions);
}

describe("LP3 direct Cloud build flag", () => {
  it("rejects the LP3 flag at the real process boundary before building", () => {
    const result = spawnSync("node", [mobileBuildScriptPath, "android-cloud"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1",
      },
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "restricted to the canonical android-cloud-debug",
    );
  });

  it("accepts only explicit truthy values", () => {
    expect(isAndroidLp3ColorPolicyEnabled({})).toBe(false);
    expect(
      isAndroidLp3ColorPolicyEnabled({
        ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "0",
      }),
    ).toBe(false);
    expect(
      isAndroidLp3ColorPolicyEnabled({
        ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: " true ",
      }),
    ).toBe(true);
    expect(
      isAndroidLp3ColorPolicyEnabled({
        ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "YES",
      }),
    ).toBe(true);
  });

  it("normalizes the passed build environment without consulting process.env", () => {
    const original = process.env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED;
    process.env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED = "1";
    try {
      const disabled = resolveAndroidLp3ColorPolicyBuildEnv({
        ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "0",
      });
      expect(disabled.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED).toBe("0");
      expect(resolveAndroidCloudStripPolicy(disabled).components).toContain(
        "Lp3ColorPolicyService",
      );

      process.env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED = "0";
      const enabled = resolveAndroidLp3ColorPolicyBuildEnv({
        ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "yes",
      });
      expect(enabled.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED).toBe("1");
      expect(resolveAndroidCloudStripPolicy(enabled).components).not.toContain(
        "Lp3ColorPolicyService",
      );
    } finally {
      if (original === undefined) {
        delete process.env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED;
      } else {
        process.env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED = original;
      }
    }
  });

  it("keeps policy files inside the ordinary Cloud strip set", () => {
    for (const component of ANDROID_LP3_COLOR_POLICY_COMPONENTS) {
      expect(ANDROID_CLOUD_STRIPPED_COMPONENTS).toContain(component);
    }
    for (const permission of ANDROID_LP3_COLOR_POLICY_PERMISSIONS) {
      expect(ANDROID_CLOUD_STRIPPED_PERMISSIONS).toContain(permission);
    }
    for (const file of ANDROID_LP3_COLOR_POLICY_JAVA_FILES) {
      expect(ANDROID_CLOUD_STRIPPED_JAVA_FILES).toContain(file);
    }
  });

  it("rejects the LP3 flag outside the dedicated direct debug lane", () => {
    const enabled = { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1" };
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud",
        env: enabled,
      }),
    ).toThrow("restricted to the canonical android-cloud-debug");
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-sms-gateway",
        env: enabled,
      }),
    ).toThrow("restricted to the canonical android-cloud-debug");
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android",
        env: enabled,
      }),
    ).toThrow("restricted to the canonical android-cloud-debug");
  });

  it("rejects Play signals even on the debug target", () => {
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud-debug",
        env: {
          ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1",
          ELIZA_PLAY_STORE_BUILD: "1",
        },
      }),
    ).toThrow("restricted to the canonical android-cloud-debug");
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud-debug",
        env: {
          ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1",
          ELIZA_BUILD_VARIANT: "STORE",
        },
      }),
    ).toThrow("restricted to the canonical android-cloud-debug");
  });

  it("rejects app-dir and whitelabel variants", () => {
    const enabled = { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1" };
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud-debug",
        env: { ...enabled, ELIZA_ANDROID_USE_APP_DIR: "1" },
      }),
    ).toThrow("app-dir");
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud-debug",
        env: enabled,
        appId: "com.example.whitelabel",
      }),
    ).toThrow("whitelabel");
  });

  it("allows only the explicit direct debug target and keeps disabled builds unchanged", () => {
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud-debug",
        env: { ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "yes" },
      }),
    ).not.toThrow();
    expect(() =>
      enforceAndroidLp3ColorPolicyBuildPolicy({
        targetName: "android-cloud",
        env: {},
      }),
    ).not.toThrow();
  });

  it("preserves only the exact LP3 delta when the direct flag is enabled", () => {
    const normal = resolveAndroidCloudStripPolicy({});
    const direct = resolveAndroidCloudStripPolicy({
      ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED: "1",
    });

    for (const component of ANDROID_LP3_COLOR_POLICY_COMPONENTS) {
      expect(normal.components).toContain(component);
      expect(direct.components).not.toContain(component);
    }
    for (const permission of ANDROID_LP3_COLOR_POLICY_PERMISSIONS) {
      expect(normal.permissions).toContain(permission);
      expect(direct.permissions).not.toContain(permission);
    }
    for (const file of ANDROID_LP3_COLOR_POLICY_JAVA_FILES) {
      expect(normal.javaFiles).toContain(file);
      expect(direct.javaFiles).not.toContain(file);
    }

    expect(direct.components).toContain("ElizaAgentService");
    expect(direct.permissions).toContain("MANAGE_APP_OPS_MODES");
    expect(ANDROID_CLOUD_STRIPPED_PERMISSIONS).not.toContain(
      "POST_NOTIFICATIONS",
    );
    expect(direct.javaFiles).toContain("ElizaAgentService.java");
  });

  it("removes the entire LP3 delta from a normal Cloud manifest", () => {
    const manifest = fs.readFileSync(manifestPath, "utf8");
    const normal = stripManifest(manifest, resolveAndroidCloudStripPolicy({}));

    for (const component of ANDROID_LP3_COLOR_POLICY_COMPONENTS) {
      expect(normal).not.toContain(component);
    }
    for (const permission of ANDROID_LP3_COLOR_POLICY_PERMISSIONS) {
      const full = `android.permission.${permission}`;
      expect(hasAndroidPermissionRequest(normal, full)).toBe(false);
    }
    for (const action of ANDROID_LP3_COLOR_POLICY_COMMAND_ACTIONS) {
      expect(normal).not.toContain(action);
    }
  });

  it("keeps the canonical platform manifest free of direct-only components", () => {
    const manifest = fs.readFileSync(manifestPath, "utf8");
    for (const component of ANDROID_LP3_COLOR_POLICY_COMPONENTS) {
      expect(manifest).not.toContain(component);
    }
    expect(manifest).not.toContain("android.permission.WRITE_SECURE_SETTINGS");
  });

  it("keeps direct-only Java out of ordinary sideload, system, and manual Gradle sources", () => {
    const ordinaryMainRoot = path.join(
      androidRoot,
      "app/src/main/java/ai/elizaos/app",
    );
    const isolatedTemplateRoot = path.join(
      androidRoot,
      "lp3-color-policy/src/debug/java/ai/elizaos/app",
    );
    for (const file of ANDROID_LP3_COLOR_POLICY_JAVA_FILES) {
      expect(fs.existsSync(path.join(ordinaryMainRoot, file))).toBe(false);
      expect(fs.existsSync(path.join(isolatedTemplateRoot, file))).toBe(true);
    }
  });

  it("declares the guarded specialUse boot contract", () => {
    const manifest = fs.readFileSync(debugManifestPath, "utf8");
    const gradle = fs.readFileSync(gradlePath, "utf8");
    const receiverStart = manifest.indexOf(
      'android:name=".Lp3ColorPolicyBootReceiver"',
    );
    const receiverBlock = manifest.slice(
      receiverStart,
      manifest.indexOf("</receiver>", receiverStart),
    );
    const initializerStart = manifest.indexOf(
      'android:name=".Lp3ColorPolicyInitializer"',
    );
    const initializerBlock = manifest.slice(
      initializerStart,
      manifest.indexOf("/>", initializerStart),
    );

    expect(manifest).toContain("Lp3ColorPolicyInitializer");
    expect(manifest).toContain("Lp3ColorPolicyService");
    expect(manifest).toContain('android:foregroundServiceType="specialUse"');
    expect(manifest).toContain("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE");
    expect(manifest).toContain("Lp3ColorPolicyBootReceiver");
    expect(manifest).not.toMatch(
      /Lp3ColorPolicy(?:Initializer|Service|BootReceiver)[\s\S]{0,160}directBootAware/,
    );
    for (const permission of ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS) {
      expect(manifest).toContain(`android.permission.${permission}`);
    }
    expect(initializerBlock).toContain('android:exported="false"');
    expect(initializerBlock).toMatch(
      /android:authorities="\$\{applicationId\}\.lp3-color-policy-initializer"/,
    );
    expect(initializerBlock).toContain('android:grantUriPermissions="false"');
    expect(initializerBlock).toContain('android:initOrder="100"');
    expect(manifest).toContain("android.intent.action.BOOT_COMPLETED");
    expect(manifest).toContain("android.intent.action.MY_PACKAGE_REPLACED");
    expect(manifest).not.toContain(
      "android.app.action.APP_BLOCK_STATE_CHANGED",
    );
    expect(manifest).not.toContain(
      "android.app.action.NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED",
    );
    expect(manifest).toContain("ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY");
    expect(manifest).toContain(
      "ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY",
    );
    expect(manifest).toContain("ai.elizaos.app.action.SYNC_LP3_COLOR_POLICY");
    for (const action of ANDROID_LP3_COLOR_POLICY_ACTIONS) {
      expect(receiverBlock).toContain(action);
    }
    expect(receiverBlock).toContain('android:exported="false"');
    expect(receiverBlock).not.toContain("android:permission=");
    expect(gradle).toContain(
      'buildConfigField "boolean", "ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED"',
    );
    expect(gradle).toContain("debug.java.srcDir");
    expect(gradle).toContain("debug.manifest.srcFile");
    expect(gradle).toContain("debug.res.srcDir");
    expect(gradle).toContain("testRelease.java.srcDir");
    expect(gradle).not.toContain("release.java.srcDir");
  });

  it("limits direct-debug USB runtime cleartext to loopback", () => {
    const manifest = fs.readFileSync(debugManifestPath, "utf8");
    const networkConfig = fs.readFileSync(usbNetworkSecurityConfigPath, "utf8");
    const platformManifest = fs.readFileSync(manifestPath, "utf8");

    expect(manifest).toContain(
      'android:networkSecurityConfig="@xml/lp3_usb_network_security_config"',
    );
    expect(networkConfig).toContain(
      '<base-config cleartextTrafficPermitted="false" />',
    );
    expect(networkConfig).toContain(
      '<domain includeSubdomains="false">127.0.0.1</domain>',
    );
    expect(networkConfig).toContain(
      '<domain includeSubdomains="false">localhost</domain>',
    );
    expect(networkConfig).not.toContain('includeSubdomains="true"');
    expect(platformManifest).not.toContain("lp3_usb_network_security_config");
  });

  it("keeps runtime opt-in private and writable only through same-UID commands", () => {
    const service = fs
      .readFileSync(servicePath, "utf8")
      .replace(/\r\n?/g, "\n");
    const initializer = fs.readFileSync(initializerPath, "utf8");
    const readme = fs.readFileSync(readmePath, "utf8");

    expect(service).toContain('PREFERENCES_NAME = "lp3_color_policy"');
    expect(service).toContain('OPT_IN_PREFERENCE = "enabled"');
    expect(service).toContain("createDeviceProtectedStorageContext");
    expect(service).toContain("Context.MODE_PRIVATE");
    expect(service).not.toContain("Settings.System");
    expect(service).toContain("if (!initialized)");
    expect(service).toContain("return START_NOT_STICKY");
    expect(service).toContain("MISSING_NOTIFICATION_PERMISSION");
    expect(service).toContain("MISSING_NOTIFICATION_DISCLOSURE");
    expect(service).toContain("Manifest.permission.POST_NOTIFICATIONS");
    expect(service).toContain("manager.areNotificationsEnabled()");
    expect(service).toContain("NotificationManager.IMPORTANCE_NONE");
    expect(service).toContain(
      "NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED",
    );
    expect(service).toContain(
      "NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED",
    );
    expect(service).toContain("Context.RECEIVER_NOT_EXPORTED");
    expect(service).toContain(
      "NotificationManager.EXTRA_NOTIFICATION_CHANNEL_ID",
    );
    expect(service).toContain("unregisterReceiver(registeredReceiver)");
    expect(service).toContain(
      "currentDecision(this);\n            if (decision",
    );
    expect(service).toContain('"service-create-post-channel"');
    expect(initializer).toContain("extends ContentProvider");
    expect(initializer).toContain(
      'Lp3ColorPolicyService.sync(appContext, "process-start")',
    );
    expect(initializer).toContain(
      'Lp3ColorPolicyService.sync(activity, "activity-resumed")',
    );
    expect(initializer).toContain("activity.requestPermissions");
    expect(initializer).toContain("shouldRequestPostNotifications");
    expect(initializer).toContain("acceptsNotificationStateChange");
    expect(initializer).toContain("app.unregisterReceiver(registeredReceiver)");
    expect(initializer).toContain("Manifest.permission.POST_NOTIFICATIONS");
    expect(readme).toContain("adb shell run-as ai.elizaos.app am broadcast");
    expect(readme).toContain(
      "adb shell pm grant ai.elizaos.app android.permission.POST_NOTIFICATIONS",
    );
    expect(readme).toContain("ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY");
    expect(readme).toContain("ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY");
    expect(readme).toContain("channel-level block");
    expect(readme).toContain("permission-prompt loop");
  });
});
