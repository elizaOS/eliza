/**
 * Tests for the apps-control worker's config parsing + arm gate.
 *
 * The arm gate (APPS_DEPLOY_ENABLED!=="1" → idle, claims nothing) is the
 * inert-by-default safety property the daemon's docs lean on: deploying the
 * unit without arming it must be a no-op, never a half-running daemon. We test
 * only the GATE-CLOSED path here — the gate-open path dynamically imports the
 * (heavy, side-effectful) apps-deploy-backend and belongs to an integration test.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  armAppsDeployBackend,
  readAppsWorkerConfig,
} from "./apps-provisioning-worker";

function makeLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    // biome-ignore lint/suspicious/noExplicitAny: test double for the structured logger
  } as any;
}

describe("readAppsWorkerConfig", () => {
  test("defaults with empty env/argv", () => {
    const c = readAppsWorkerConfig({}, []);
    expect(c.pollIntervalMs).toBe(30_000);
    expect(c.batchSize).toBe(3);
    expect(c.runOnce).toBe(false);
  });

  test("parses WORKER_POLL_INTERVAL + WORKER_BATCH_SIZE", () => {
    const c = readAppsWorkerConfig(
      { WORKER_POLL_INTERVAL: "5000", WORKER_BATCH_SIZE: "10" },
      [],
    );
    expect(c.pollIntervalMs).toBe(5_000);
    expect(c.batchSize).toBe(10);
  });

  test("falls back to defaults on garbage / non-positive values", () => {
    const c = readAppsWorkerConfig(
      { WORKER_POLL_INTERVAL: "not-a-number", WORKER_BATCH_SIZE: "-4" },
      [],
    );
    expect(c.pollIntervalMs).toBe(30_000);
    expect(c.batchSize).toBe(3);
  });

  test("runOnce via WORKER_RUN_ONCE=1 or --once flag", () => {
    expect(readAppsWorkerConfig({ WORKER_RUN_ONCE: "1" }, []).runOnce).toBe(
      true,
    );
    expect(readAppsWorkerConfig({}, ["--once"]).runOnce).toBe(true);
    expect(readAppsWorkerConfig({ WORKER_RUN_ONCE: "0" }, []).runOnce).toBe(
      false,
    );
  });
});

describe("armAppsDeployBackend — gate-closed safety", () => {
  test("returns false and idles when APPS_DEPLOY_ENABLED is unset", async () => {
    const prev = process.env.APPS_DEPLOY_ENABLED;
    delete process.env.APPS_DEPLOY_ENABLED;
    try {
      const logger = makeLogger();
      const armed = await armAppsDeployBackend(logger);
      expect(armed).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
      // It must NOT log "armed" when the gate is closed.
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.APPS_DEPLOY_ENABLED;
      else process.env.APPS_DEPLOY_ENABLED = prev;
    }
  });

  test("returns false when APPS_DEPLOY_ENABLED is any value other than '1'", async () => {
    const prev = process.env.APPS_DEPLOY_ENABLED;
    process.env.APPS_DEPLOY_ENABLED = "true"; // not exactly "1"
    try {
      const armed = await armAppsDeployBackend(makeLogger());
      expect(armed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.APPS_DEPLOY_ENABLED;
      else process.env.APPS_DEPLOY_ENABLED = prev;
    }
  });
});
