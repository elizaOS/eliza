import { describe, expect, test } from "bun:test";
import { readWorkerConfig } from "../../scripts/daemons/provisioning-worker";

describe("provisioning worker config", () => {
  test("parses daemon config without requiring legacy Neon worker env", () => {
    const config = readWorkerConfig(
      {
        WORKER_POLL_INTERVAL: "1500",
        WORKER_BATCH_SIZE: "7",
      } as NodeJS.ProcessEnv,
      [],
    );

    expect(config).toEqual({
      pollIntervalMs: 1500,
      batchSize: 7,
      runOnce: false,
    });
  });

  test("supports one-shot mode from env or argv", () => {
    expect(readWorkerConfig({ WORKER_RUN_ONCE: "1" } as NodeJS.ProcessEnv, []).runOnce).toBe(true);
    expect(readWorkerConfig({} as NodeJS.ProcessEnv, ["--once"]).runOnce).toBe(true);
  });
});
