import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateCapabilityManifestDocument } from "./boot-validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const vendorDir = path.join(repoRoot, "packages/os/android/vendor/eliza");
const packageName = "ai.elizaos.app";
const brand = {
  appName: "Eliza",
  classPrefix: "Eliza",
  packageName,
};

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function readJson(relPath) {
  return JSON.parse(read(relPath));
}

test("AOSP image declares Eliza as the assistant role owner", () => {
  const configXml = read(
    "packages/os/android/vendor/eliza/overlays/frameworks/base/core/res/res/values/config.xml",
  );
  assert.match(
    configXml,
    new RegExp(
      `<string\\b[^>]*name="config_defaultAssistant"[^>]*>${packageName}<\\/string>`,
    ),
  );

  const commonMk = read("packages/os/android/vendor/eliza/eliza_common.mk");
  assert.match(
    commonMk,
    /PRODUCT_PACKAGE_OVERLAYS \+=\s*\\\n\s*vendor\/eliza\/overlays/,
  );
  assert.match(commonMk, /aosp-assistant-full-control\.json/);
  assert.match(
    commonMk,
    /product\/etc\/eliza\/aosp-assistant-full-control\.json/,
  );
});

test("AOSP capability manifest records the full assistant/control path", () => {
  const manifest = readJson(
    "packages/os/android/vendor/eliza/manifests/aosp-assistant-full-control.json",
  );
  assert.equal(manifest.packageName, packageName);
  assert.equal(
    manifest.roleDefaults["android.app.role.ASSISTANT"],
    packageName,
  );
  assert.deepEqual(manifest.apiConstants, {
    assistantRole: {
      symbol: "RoleManager.ROLE_ASSISTANT",
      value: "android.app.role.ASSISTANT",
    },
    assistAction: {
      symbol: "Intent.ACTION_ASSIST",
      value: "android.intent.action.ASSIST",
    },
    voiceCommandAction: {
      symbol: "Intent.ACTION_VOICE_COMMAND",
      value: "android.intent.action.VOICE_COMMAND",
    },
  });
  assert.deepEqual(manifest.assistantEntryPoints, [
    "android.intent.action.ASSIST",
    "android.intent.action.VOICE_COMMAND",
  ]);
  assert.equal(manifest.assistantResolution.role, "android.app.role.ASSISTANT");
  assert.equal(
    manifest.assistantResolution.defaultHolderResource,
    "config_defaultAssistant",
  );
  assert.equal(manifest.assistantResolution.defaultHolder, packageName);
  assert.equal(
    manifest.assistantResolution.activity,
    `${packageName}.ElizaAssistActivity`,
  );
  assert.equal(manifest.directBoot.receiver, "ElizaBootReceiver");
  assert.equal(manifest.directBoot.directBootAware, true);
  assert.ok(
    manifest.directBoot.actions.includes(
      "android.intent.action.LOCKED_BOOT_COMPLETED",
    ),
  );
  assert.ok(
    manifest.directBoot.actions.includes(
      "android.intent.action.MY_PACKAGE_REPLACED",
    ),
  );

  for (const permission of [
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.MANAGE_APP_OPS_MODES",
    "android.permission.MANAGE_VIRTUAL_MACHINE",
    "android.permission.READ_FRAME_BUFFER",
    "android.permission.INJECT_EVENTS",
    "android.permission.REAL_GET_TASKS",
  ]) {
    assert.ok(
      manifest.privilegedPermissions.includes(permission),
      `capability manifest should include ${permission}`,
    );
  }

  for (const capability of [
    "accessibility",
    "notificationListener",
    "screenCapture",
    "inputControl",
    "appInventory",
    "voiceCommand",
  ]) {
    assert.ok(
      manifest.capabilityDeclarations[capability],
      `capability manifest should declare ${capability}`,
    );
  }
  assert.deepEqual(manifest.capabilityDeclarations.accessibility, {
    status: "declared-aosp-system-service",
    component: "ElizaAccessibilityService",
    intentAction: "android.accessibilityservice.AccessibilityService",
    permission: "android.permission.BIND_ACCESSIBILITY_SERVICE",
    metadata: "@xml/eliza_accessibility_service",
    componentPolicy:
      "Declare only in the AOSP/system build; Play/cloud builds must strip the service, Java source, and accessibility-service XML resource.",
    notes:
      "Used for accessibility tree observation and user-consented gesture dispatch on non-privileged paths; privileged AOSP input uses INJECT_EVENTS.",
  });
  assert.deepEqual(manifest.capabilityDeclarations.notificationListener, {
    status: "declared-aosp-system-service",
    component: "ElizaNotificationListenerService",
    intentAction: "android.service.notification.NotificationListenerService",
    permission: "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
    componentPolicy:
      "Declare only in the AOSP/system build; cloud/Play builds must strip the service and Java source.",
    notes:
      "Used by the privileged assistant image to observe notification lifecycle events for the local agent.",
  });
  for (const [component, type] of [
    ["ElizaAgentService", "specialUse"],
    ["GatewayConnectionService", "dataSync"],
    ["ElizaVoiceCaptureService", "microphone"],
    ["ScreenCapture", "mediaProjection"],
  ]) {
    assert.ok(
      manifest.foregroundServices.some(
        (service) => service.component === component && service.type === type,
      ),
      `capability manifest should declare foreground service ${component}/${type}`,
    );
  }
  assert.equal(
    manifest.systemImageRequirements.installPath,
    "/system/priv-app/Eliza/Eliza.apk",
  );
  assert.equal(manifest.systemImageRequirements.soong.privileged, true);
  assert.equal(manifest.systemImageRequirements.soong.certificate, "platform");
  assert.equal(manifest.playStorePolicy.stripTarget, "android-cloud");
  assert.equal(manifest.playStorePolicy.allowed, false);
  for (const component of [
    "ElizaAgentService",
    "ElizaAccessibilityService",
    "ElizaAssistActivity",
    "ElizaBootReceiver",
    "ElizaNotificationListenerService",
    "ElizaVoiceCaptureService",
  ]) {
    assert.ok(manifest.playStorePolicy.mustStripComponents.includes(component));
  }
  for (const permission of [
    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.MANAGE_APP_OPS_MODES",
    "android.permission.MANAGE_VIRTUAL_MACHINE",
    "android.permission.READ_FRAME_BUFFER",
    "android.permission.INJECT_EVENTS",
    "android.permission.REAL_GET_TASKS",
    "android.permission.BIND_ACCESSIBILITY_SERVICE",
    "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
  ]) {
    assert.ok(
      manifest.playStorePolicy.mustStripPermissions.includes(permission),
    );
  }
});

test("boot validator structurally validates the on-device capability manifest", () => {
  const manifest = readJson(
    "packages/os/android/vendor/eliza/manifests/aosp-assistant-full-control.json",
  );
  assert.doesNotThrow(() =>
    validateCapabilityManifestDocument(JSON.stringify(manifest), brand),
  );

  const missingBootStrip = JSON.parse(JSON.stringify(manifest));
  missingBootStrip.playStorePolicy.mustStripPermissions =
    missingBootStrip.playStorePolicy.mustStripPermissions.filter(
      (permission) =>
        permission !== "android.permission.RECEIVE_BOOT_COMPLETED",
    );
  assert.throws(
    () => validateCapabilityManifestDocument(missingBootStrip, brand),
    /RECEIVE_BOOT_COMPLETED/,
  );
});

test("AOSP privapp whitelist covers privileged control permissions", () => {
  const privapp = read(
    "packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml",
  );
  assert.match(
    privapp,
    new RegExp(`<privapp-permissions package="${packageName}"`),
  );
  for (const permission of [
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.MANAGE_APP_OPS_MODES",
    "android.permission.MANAGE_VIRTUAL_MACHINE",
    "android.permission.READ_FRAME_BUFFER",
    "android.permission.INJECT_EVENTS",
    "android.permission.REAL_GET_TASKS",
  ]) {
    assert.match(privapp, new RegExp(`name="${permission}"`));
  }
});

test("AOSP/mobile build script routes ASSIST and VOICE_COMMAND but strips them from Play", () => {
  const buildScript = read("packages/app-core/scripts/run-mobile-build.mjs");
  for (const marker of [
    "android.intent.action.ASSIST",
    "android.intent.action.VOICE_COMMAND",
    '"ElizaAccessibilityService"',
    '"ElizaAssistActivity"',
    '"ElizaNotificationListenerService"',
    '"BIND_ACCESSIBILITY_SERVICE"',
    '"BIND_NOTIFICATION_LISTENER_SERVICE"',
    "android.accessibilityservice.AccessibilityService",
    "android.service.notification.NotificationListenerService",
    "eliza_accessibility_service.xml",
    '"ElizaVoiceCaptureService"',
    '"FOREGROUND_SERVICE_MEDIA_PROJECTION"',
    '"FOREGROUND_SERVICE_MICROPHONE"',
    '"FOREGROUND_SERVICE_SPECIAL_USE"',
    '"RECEIVE_BOOT_COMPLETED"',
    '"READ_FRAME_BUFFER"',
    '"INJECT_EVENTS"',
    '"REAL_GET_TASKS"',
    '"@elizaos/capacitor-screencapture"',
    "auditAndroidCloudSource",
    "auditAndroidSystemSource",
  ]) {
    assert.match(buildScript, new RegExp(marker.replaceAll("/", "\\/")));
  }
});

test("distro validators check assistant intent and capability policy", () => {
  const staticValidator = read("scripts/distro-android/validate.mjs");
  for (const marker of [
    "assistantResolution",
    "apiConstants",
    "directBootAware",
    "mustStripComponents",
    "mustStripPermissions",
    "mustStripPlugins",
    "accessibility.component",
    "notificationListener.component",
    "ElizaVoiceCaptureService",
    "android-cloud stripped permission policy",
  ]) {
    assert.match(staticValidator, new RegExp(marker));
  }

  const bootValidator = read("scripts/distro-android/boot-validate.mjs");
  for (const marker of [
    "validateAssistantResolutions",
    "android.intent.action.ASSIST",
    "android.intent.action.VOICE_COMMAND",
    "REQUIRED_PRIVILEGED_PERMISSIONS",
    "validateCapabilityManifestDocument",
    "validateCapabilityManifest",
    "/product/etc/eliza/aosp-assistant-full-control.json",
  ]) {
    assert.match(bootValidator, new RegExp(marker.replaceAll("/", "\\/")));
  }
});

test("AOSP vendor tree root exists for validator defaults", () => {
  assert.equal(fs.existsSync(vendorDir), true);
});
