/**
 * Verifies the committed Android entry points all delegate periodic wake work
 * to the single schedule/cancel authority instead of enqueuing independently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const javaRoot = path.resolve(
  scriptsDir,
  "../platforms/android/app/src/main/java/ai/elizaos/app",
);

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
    expect(activity).not.toContain("ElizaWorkScheduler.enqueuePeriodic");
    expect(bootReceiver).not.toContain("ElizaWorkScheduler.enqueuePeriodic");
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

    expect(service).toMatch(
      /writeLocalAgentTokenFile\(token\);\s*ElizaWorkScheduler\.reconcile/,
    );
    expect(service).toMatch(
      /deleteLocalAgentTokenFile\(\);\s*ElizaWorkScheduler\.reconcile/,
    );
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
});
