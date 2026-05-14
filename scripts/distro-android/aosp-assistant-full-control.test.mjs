import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const vendorDir = path.join(repoRoot, "packages/os/android/vendor/eliza");
const packageName = "ai.elizaos.app";

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
  assert.match(commonMk, /PRODUCT_PACKAGE_OVERLAYS \+=\s*\\\n\s*vendor\/eliza\/overlays/);
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
  assert.equal(manifest.roleDefaults["android.app.role.ASSISTANT"], packageName);
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
    manifest.directBoot.actions.includes("android.intent.action.LOCKED_BOOT_COMPLETED"),
  );
  assert.ok(
    manifest.directBoot.actions.includes("android.intent.action.MY_PACKAGE_REPLACED"),
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
    "ElizaAssistActivity",
    "ElizaBootReceiver",
    "ElizaVoiceCaptureService",
  ]) {
    assert.ok(manifest.playStorePolicy.mustStripComponents.includes(component));
  }
  for (const permission of [
    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.MANAGE_APP_OPS_MODES",
    "android.permission.MANAGE_VIRTUAL_MACHINE",
    "android.permission.READ_FRAME_BUFFER",
    "android.permission.INJECT_EVENTS",
    "android.permission.REAL_GET_TASKS",
  ]) {
    assert.ok(manifest.playStorePolicy.mustStripPermissions.includes(permission));
  }
});

test("AOSP privapp whitelist covers privileged control permissions", () => {
  const privapp = read(
    "packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml",
  );
  assert.match(privapp, new RegExp(`<privapp-permissions package="${packageName}"`));
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
    "\"ElizaAssistActivity\"",
    "\"ElizaVoiceCaptureService\"",
    "\"FOREGROUND_SERVICE_MEDIA_PROJECTION\"",
    "\"FOREGROUND_SERVICE_MICROPHONE\"",
    "\"FOREGROUND_SERVICE_SPECIAL_USE\"",
    "\"READ_FRAME_BUFFER\"",
    "\"INJECT_EVENTS\"",
    "\"REAL_GET_TASKS\"",
    "\"@elizaos/capacitor-screencapture\"",
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
    "directBootAware",
    "mustStripComponents",
    "mustStripPermissions",
    "mustStripPlugins",
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
    "validateCapabilityManifest",
    "/product/etc/eliza/aosp-assistant-full-control.json",
  ]) {
    assert.match(bootValidator, new RegExp(marker.replaceAll("/", "\\/")));
  }
});

test("AOSP vendor tree root exists for validator defaults", () => {
  assert.equal(fs.existsSync(vendorDir), true);
});
