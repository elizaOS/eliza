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
  ]) {
    assert.ok(
      manifest.capabilityDeclarations[capability],
      `capability manifest should declare ${capability}`,
    );
  }
  assert.equal(manifest.playStorePolicy.stripTarget, "android-cloud");
  assert.equal(manifest.playStorePolicy.allowed, false);
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
  assert.match(buildScript, /android\.intent\.action\.ASSIST/);
  assert.match(buildScript, /android\.intent\.action\.VOICE_COMMAND/);
  assert.match(buildScript, /"ElizaAssistActivity"/);
  assert.match(buildScript, /"READ_FRAME_BUFFER"/);
  assert.match(buildScript, /"INJECT_EVENTS"/);
  assert.match(buildScript, /"REAL_GET_TASKS"/);
  assert.match(buildScript, /"@elizaos\/capacitor-screencapture"/);
});

test("AOSP vendor tree root exists for validator defaults", () => {
  assert.equal(fs.existsSync(vendorDir), true);
});
