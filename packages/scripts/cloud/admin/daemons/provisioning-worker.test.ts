import { describe, expect, it, mock } from "bun:test";
import {
  assertProvisioningWorkerPreflight,
  maybePublishHeartbeat,
} from "./provisioning-worker";

type WorkerLogger = Parameters<typeof maybePublishHeartbeat>[0];

function makeLogger(): WorkerLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as unknown as WorkerLogger;
}

describe("assertProvisioningWorkerPreflight", () => {
  it("verifies KMS can create or load the preflight key", async () => {
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));

    await assertProvisioningWorkerPreflight({
      env: { ELIZA_KMS_BACKEND: "local" } as NodeJS.ProcessEnv,
      createKmsClient,
    });

    expect(createKmsClient).toHaveBeenCalledWith({
      env: { ELIZA_KMS_BACKEND: "local" },
    });
    expect(getOrCreateKey).toHaveBeenCalledWith(
      "system:provisioning-worker-preflight/v1",
    );
  });

  it("fails before the worker can heartbeat or claim jobs when KMS config is missing", async () => {
    await expect(
      assertProvisioningWorkerPreflight({
        env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
        createKmsClient: () => {
          throw new Error(
            "ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}",
          );
        },
      }),
    ).rejects.toThrow(
      "Refusing to publish a healthy heartbeat or claim provisioning jobs",
    );
  });

  it("fails when the selected KMS backend exists but cannot service key operations", async () => {
    await expect(
      assertProvisioningWorkerPreflight({
        env: { ELIZA_KMS_BACKEND: "steward" } as NodeJS.ProcessEnv,
        createKmsClient: () => ({
          getOrCreateKey: async () => {
            throw new Error("Steward endpoint unavailable");
          },
        }),
      }),
    ).rejects.toThrow("Steward endpoint unavailable");
  });
});

describe("maybePublishHeartbeat (liveness gate)", () => {
  const fresh = Date.now();

  it("does NOT publish when preflight has not passed (preflightOk=false)", async () => {
    const publish = mock(async () => {});
    const result = await maybePublishHeartbeat(makeLogger(), {
      preflightOk: false,
      lastCycleCompletedAt: fresh,
      now: fresh,
      publish,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ published: false, watchdogTripped: false });
  });

  it("DOES publish when preflight passed and the cycle is progressing", async () => {
    const publish = mock(async () => {});
    const result = await maybePublishHeartbeat(makeLogger(), {
      preflightOk: true,
      lastCycleCompletedAt: fresh,
      now: fresh,
      publish,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ published: true, watchdogTripped: false });
  });

  it("withholds the heartbeat when the watchdog trips, even if preflight is OK", async () => {
    const publish = mock(async () => {});
    const logger = makeLogger();
    // Last cycle completed > 5min ago → wedged.
    const stale = fresh - (5 * 60_000 + 1);
    const result = await maybePublishHeartbeat(logger, {
      preflightOk: true,
      lastCycleCompletedAt: stale,
      now: fresh,
      publish,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ published: false, watchdogTripped: true });
    expect(logger.error).toHaveBeenCalled();
  });
});
