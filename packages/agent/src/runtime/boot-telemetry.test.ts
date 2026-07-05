/**
 * Verifies boot/restart telemetry persistence: the native startup trace id
 * (ELIZA_STARTUP_TRACE_ID) is trimmed and written into both the boot
 * latest.json and the restart events.json under the state dir. Uses a real temp
 * ELIZA_STATE_DIR and reads the files back off disk.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordBootEvent, recordBootTelemetry } from "./boot-telemetry.ts";
import type { BootSummary } from "./boot-timer.ts";

const ENV_KEYS = [
  "ELIZA_DISABLE_TELEMETRY",
  "ELIZA_DESKTOP_API_WATCH",
  "ELIZA_DEV_NO_WATCH",
  "ELIZA_DEV_SOURCE_WATCH",
  "ELIZA_STARTUP_TRACE_ID",
  "ELIZA_STATE_DIR",
  "NODE_ENV",
] as const;

let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined> =
  Object.create(null);
let stateDir: string | undefined;

beforeEach(async () => {
  previousEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as typeof previousEnv;
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-boot-telemetry-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_STARTUP_TRACE_ID = " android-trace-123 ";
  process.env.NODE_ENV = "development";
  delete process.env.ELIZA_DISABLE_TELEMETRY;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

function sampleSummary(): BootSummary {
  return {
    label: "[test-boot]",
    totalMs: 42,
    startedAt: 1_700_000_000_000,
    laps: [{ name: "boot", ms: 42, cumulativeMs: 42 }],
  };
}

describe("boot telemetry startup trace id", () => {
  it("persists the native startup trace id into boot and restart telemetry", async () => {
    await recordBootTelemetry(sampleSummary());
    await recordBootEvent("[test-boot]");

    if (!stateDir) {
      throw new Error("stateDir was not initialized");
    }
    const root = stateDir;
    const bootLatest = JSON.parse(
      await readFile(
        path.join(root, "telemetry", "boot", "latest.json"),
        "utf8",
      ),
    ) as { traceId?: string };
    const restartEvents = JSON.parse(
      await readFile(
        path.join(root, "telemetry", "restart", "events.json"),
        "utf8",
      ),
    ) as Array<{ traceId?: string }>;

    expect(bootLatest.traceId).toBe("android-trace-123");
    expect(restartEvents.at(-1)?.traceId).toBe("android-trace-123");
  });

  it("records the real dev watch state into restart telemetry", async () => {
    process.env.ELIZA_DEV_NO_WATCH = "0";
    await recordBootEvent("[test-no-watch]");

    process.env.ELIZA_DESKTOP_API_WATCH = "1";
    await recordBootEvent("[test-watch]");

    if (!stateDir) {
      throw new Error("stateDir was not initialized");
    }
    const restartEvents = JSON.parse(
      await readFile(
        path.join(stateDir, "telemetry", "restart", "events.json"),
        "utf8",
      ),
    ) as Array<{ label: string; watch: boolean }>;

    expect(restartEvents.at(-2)).toMatchObject({
      label: "[test-no-watch]",
      watch: false,
    });
    expect(restartEvents.at(-1)).toMatchObject({
      label: "[test-watch]",
      watch: true,
    });
  });
});
