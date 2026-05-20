import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appCoreRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(
  appCoreRoot,
  "platforms",
  "android",
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);
const installScriptPath = path.join(appCoreRoot, "scripts", "install-android-sms-gateway.mjs");
const watchScriptPath = path.join(appCoreRoot, "scripts", "watch-sms-gateway-readiness.mjs");
const readinessScriptPath = path.join(appCoreRoot, "scripts", "check-sms-gateway-readiness.mjs");
const packageJsonPath = path.join(appCoreRoot, "package.json");

test("Android template keeps the default SMS gateway surface", () => {
  const manifest = fs.readFileSync(manifestPath, "utf8");

  for (const marker of [
    "android.permission.READ_SMS",
    "android.permission.SEND_SMS",
    "android.permission.RECEIVE_SMS",
    "android.permission.RECEIVE_MMS",
    "android.permission.RECEIVE_WAP_PUSH",
    "android.hardware.telephony",
    ".ElizaSmsReceiver",
    ".ElizaMmsReceiver",
    ".ElizaSmsGatewayService",
    ".ElizaRespondViaMessageService",
    ".ElizaSmsComposeActivity",
    "android.provider.Telephony.SMS_DELIVER",
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "android.intent.action.SENDTO",
    "android.permission.BROADCAST_SMS",
    "android.permission.BROADCAST_WAP_PUSH",
    "android.permission.SEND_RESPOND_VIA_MESSAGE",
  ]) {
    assert.match(manifest, new RegExp(escapeRegExp(marker)));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Android gateway installer supports one-command wireless pairing", () => {
  const script = fs.readFileSync(installScriptPath, "utf8");
  const watchScript = fs.readFileSync(watchScriptPath, "utf8");
  const readinessScript = fs.readFileSync(readinessScriptPath, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  for (const marker of [
    "--pair <endpoint>",
    "--pair-code <code>",
    "--wait-pair <seconds>",
    "--connect <endpoint>",
    "Enter Wireless debugging pairing code",
    "Timed out waiting",
    "adb pair",
    "adb connect",
    "_adb-tls-pairing",
    "_adb-tls-connect",
    "none look like an Android phone",
  ]) {
    assert.match(script, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "mdns",
    "_adb-tls-pairing",
    "wireless pairing ready",
    "--pair",
    "--connect auto",
    "Pixel|Samsung",
  ]) {
    assert.match(watchScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "printGateSection",
    "\\bBLOCKED\\b",
    '"status"\\s*:\\s*"blocked"',
    "none look like an Android phone",
  ]) {
    assert.match(readinessScript, new RegExp(escapeRegExp(marker)));
  }

  assert.equal(
    packageJson.scripts["sms-gateway:pair"],
    "node ./scripts/install-android-sms-gateway.mjs --pair auto --connect auto --wait-device 60 --grant-role --clear-logcat --watch-logs 60",
  );
});
