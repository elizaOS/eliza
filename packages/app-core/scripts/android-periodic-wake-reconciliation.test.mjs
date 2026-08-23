/**
 * Verifies the committed Android entry points all delegate periodic wake work
 * to the single schedule/cancel authority instead of enqueuing independently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { ensureElizaBootReceiverManifest } from "./run-mobile-build.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const javaRoot = path.resolve(
  scriptsDir,
  "../platforms/android/app/src/main/java/ai/elizaos/app",
);
const androidManifest = path.resolve(
  scriptsDir,
  "../platforms/android/app/src/main/AndroidManifest.xml",
);
const mobileBuildScript = path.resolve(scriptsDir, "run-mobile-build.mjs");

function source(name) {
  return fs.readFileSync(path.join(javaRoot, name), "utf8");
}

describe("Android periodic wake reconciliation (#17874)", () => {
  it("routes activity and boot/package entry points through reconcile", () => {
    const activity = source("MainActivity.java");
    const bootReceiver = source("ElizaBootReceiver.java");

    expect(activity).toContain(
      "ElizaWorkScheduler.reconcile(getApplicationContext())",
    );
    expect(bootReceiver).toContain("ElizaWorkScheduler.reconcile(context)");
    expect(fs.readFileSync(androidManifest, "utf8")).toContain(
      "android.intent.action.MY_PACKAGE_REPLACED",
    );
    expect(activity).not.toContain("ElizaWorkScheduler.enqueuePeriodic");
    expect(bootReceiver).not.toContain("ElizaWorkScheduler.enqueuePeriodic");
    expect(bootReceiver).toMatch(
      /if \(!shouldHandleAction\(action\)\) \{\s*return;\s*\}[\s\S]*ElizaWorkScheduler\.reconcile\(context\)/,
    );
    expect(bootReceiver).toMatch(
      /shouldHandleAction\(String action\)[\s\S]*MY_PACKAGE_REPLACED/,
    );
  });

  it("preserves package replacement in the post-overlay receiver manifest", () => {
    const input = `
      <manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application>
          <receiver android:name="ai.elizaos.app.ElizaBootReceiver">
            <intent-filter>
              <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
          </receiver>
        </application>
      </manifest>`;

    const overlaid = ensureElizaBootReceiverManifest(input, "ai.elizaos.app");

    expect(overlaid).toContain("android.intent.action.LOCKED_BOOT_COMPLETED");
    expect(overlaid).toContain("android.intent.action.BOOT_COMPLETED");
    expect(overlaid).toContain("android.intent.action.MY_PACKAGE_REPLACED");
    expect(overlaid.match(/ElizaBootReceiver/g)).toHaveLength(1);

    const buildSource = fs.readFileSync(mobileBuildScript, "utf8");
    const overlayBody = buildSource.match(
      /function overlayAndroid\([\s\S]*?\n}\n\nfunction /,
    )?.[0];
    expect(overlayBody).toBeDefined();
    expect(overlayBody).toContain(
      "xml = ensureElizaBootReceiverManifest(xml, androidPackage)",
    );
  });

  it("reconciles runtime/background preference changes while the app is alive", () => {
    const activity = source("MainActivity.java");

    expect(activity).toContain("registerOnSharedPreferenceChangeListener");
    expect(activity).toContain(
      "ElizaWorkScheduler.RUNTIME_MODE_KEY.equals(key)",
    );
    expect(activity).toContain(
      "ElizaWorkScheduler.BACKGROUND_ENABLED_KEY.equals(key)",
    );
    expect(activity).toContain("unregisterOnSharedPreferenceChangeListener");
  });

  it("reconciles native token provisioning and removal", () => {
    const service = source("ElizaAgentService.java");
    const scheduler = source("ElizaWorkScheduler.java");

    expect(service).toMatch(
      /writeLocalAgentTokenFile\(token\);\s*ElizaWorkScheduler\.credentialProvisioned/,
    );
    expect(scheduler).toContain("putBoolean(RUNTIME_STOPPED_KEY, true)");
    expect(scheduler).toMatch(
      /ElizaAgentService\.localAgentToken\(context\),\s*ownershipPrefs\(context\)\.getBoolean\(RUNTIME_STOPPED_KEY, false\)/,
    );
    expect(service).toMatch(
      /if \(restartFirst\) \{\s*stopAgentProcess\(false\);\s*\}\s*startAgentProcess\(!restartFirst\)/,
    );
    expect(service).toMatch(
      /ElizaWorkScheduler\.runtimeStopped\(getApplicationContext\(\)\);[\s\S]*?deleteLocalAgentTokenFile\(\)/,
    );
    expect(service).toMatch(
      /if \(allowAdoption && isLocalAgentSocketListening\(\)\) \{[\s\S]*restoreAdoptedRuntimeOwnership\(\);[\s\S]*return;/,
    );
    expect(service).toMatch(
      /restoreAdoptedRuntimeOwnership\(\)[\s\S]*localAgentToken\(context\)[\s\S]*ElizaWorkScheduler\.credentialProvisioned\(context\)/,
    );
    expect(service).toMatch(
      /stopAgentProcess\(false\);\s*scheduleRestart\(true\)/,
    );
  });

  it("serializes decisions and bounds socket retries by one deadline", () => {
    const scheduler = source("ElizaWorkScheduler.java");
    const service = source("ElizaAgentService.java");

    expect(scheduler).toContain("static synchronized void reconcile");
    expect(scheduler).toContain(
      "static synchronized void credentialProvisioned",
    );
    expect(scheduler).toContain("static synchronized void runtimeStopped");
    expect(service).toMatch(
      /readFrameLine\([\s\S]*?socket\.setSoTimeout\(remainingSocketTimeout\(deadlineElapsedMs\)\)[\s\S]*?beforeRead\.run\(\);[\s\S]*?int b = in\.read\(\)/,
    );
    expect(service).toMatch(
      /for \([\s\S]*readFrameLine\(socket, in, deadlineElapsedMs\)[\s\S]*line = readFrameLine\(socket, in, deadlineElapsedMs\)/,
    );
    expect(service).toContain("Math.min(250L * (attempt + 1), remainingMs)");
  });

  it("keeps the worker on authenticated app-owned IPC", () => {
    const worker = source("ElizaTasksWorker.java");

    expect(worker).toContain("ElizaWorkScheduler.readDecision(context)");
    expect(worker).toContain(
      'headers.put("Authorization", "Bearer " + deviceSecret)',
    );
    expect(worker).toContain("ElizaAgentService.requestLocalAgent");
    expect(worker).not.toContain('"eliza:device-secret"');
    expect(worker).not.toContain('"eliza:agent-base"');
  });

  it("returns repeated service starts before the cold-boot process lock", () => {
    const service = source("ElizaAgentService.java");
    const requestStartBody = service.match(
      /private void requestAgentStart\(boolean restartFirst\) \{([\s\S]*?)\n {4}\}\n\n {4}private void startAgentProcess/,
    )?.[1];

    expect(service).toContain("private volatile Thread startWorker");
    expect(requestStartBody).toBeDefined();
    expect(requestStartBody).toMatch(
      /Thread activeStartWorker = startWorker;[\s\S]*activeStartWorker != null[\s\S]*activeStartWorker\.isAlive\(\)[\s\S]*return;[\s\S]*synchronized \(processLock\)/,
    );
  });

  it("enters foreground without PendingIntent binder work on the main thread", () => {
    for (const name of [
      "ElizaAgentService.java",
      "GatewayConnectionService.java",
    ]) {
      const service = source(name);
      const onCreateBody = service.match(
        /public void onCreate\(\) \{([\s\S]*?)\n {4}\}\n\n {4}@Override\n {4}public int onStartCommand/,
      )?.[1];
      const bootstrapBody = service.match(
        /private Notification buildBootstrapNotification\([\s\S]*?\) \{([\s\S]*?)\n {4}\}/,
      )?.[1];

      expect(onCreateBody).toContain("buildBootstrapNotification");
      expect(onCreateBody).not.toContain("buildNotification(");
      expect(bootstrapBody).toBeDefined();
      expect(bootstrapBody).not.toContain("PendingIntent");
    }
  });
});
