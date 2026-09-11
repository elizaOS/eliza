/** Exercises strict cleanup of a real runtime after its selected provider rejects disposal, without inference. */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

async function run(): Promise<void> {
  const { createScenarioRuntime } = await import(
    "@elizaos/scenario-runner/runtime-factory"
  );
  const { default: openaiPlugin } = await import("@elizaos/plugin-openai");
  const evidencePath = process.env.ELIZA_SYNTHETIC_RUNTIME_LEDGER;
  assert.ok(evidencePath);
  const keys = [
    "PGLITE_DATA_DIR",
    "SKILLS_DIR",
    "WEBSITE_BLOCKER_HOSTS_FILE_PATH",
    "SELFCONTROL_HOSTS_FILE_PATH",
    "ELIZA_DISABLE_ACTIVITY_TRACKER",
    "ELIZA_DISABLE_PROACTIVE_AGENT",
    "ELIZA_DISABLE_LIFEOPS_SCHEDULER",
  ] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let disposeCalls = 0;
  openaiPlugin.dispose = async () => {
    disposeCalls += 1;
    throw new Error("controlled provider disposal failure");
  };
  const result = await createScenarioRuntime({
    preferredProvider: "openai",
    useDeterministicModel: false,
    isolateFilesystemState: true,
  });
  assert.equal(result.providerName, "openai");
  assert.ok(existsSync(result.pgliteDir));
  assert.ok(result.runtime.getAllServices().size > 0);
  await assert.rejects(result.cleanup(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(
      error.errors.some(
        (cause) =>
          cause instanceof Error &&
          cause.message === "controlled provider disposal failure",
      ),
    );
    return true;
  });
  assert.equal(disposeCalls, 1);
  assert.equal(existsSync(result.pgliteDir), false);
  if (result.skillsDir) assert.equal(existsSync(result.skillsDir), false);
  if (result.hostsFilePath)
    assert.equal(existsSync(result.hostsFilePath), false);
  for (const key of keys) assert.equal(process.env[key], prior[key]);
  const ledger = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    events: Array<{
      phase: string;
      serviceType?: string;
      services?: Array<{ serviceType: string; hasStop: boolean }>;
    }>;
  };
  assert.ok(
    ledger.events.some((event) => event.phase === "service-stop-complete"),
  );
  const beforeStop = ledger.events.find(
    (event) => event.phase === "before-stop",
  );
  assert.ok(beforeStop?.services?.length);
  const stopped = new Set(
    ledger.events
      .filter((event) => event.phase === "service-stop-complete")
      .map((event) => event.serviceType),
  );
  for (const service of beforeStop.services) {
    if (service.hasStop)
      assert.ok(
        stopped.has(service.serviceType),
        `service not stopped: ${service.serviceType}`,
      );
  }
  assert.ok(ledger.events.some((event) => event.phase === "after-close"));
  writeFileSync(
    `${evidencePath}.completion`,
    JSON.stringify({
      cleanupCompleteAt: Date.now(),
      disposeCalls,
      databaseRemoved: true,
      environmentRestored: true,
    }),
  );
}

try {
  await run();
} catch (error) {
  // error-policy:J1 The isolated child reports cleanup assertions and exits naturally.
  const diagnostic = process.env.ELIZA_SYNTHETIC_RUNTIME_LEDGER;
  if (diagnostic)
    writeFileSync(
      `${diagnostic}.failure`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
