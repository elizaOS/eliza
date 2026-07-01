import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Verifies the single-service internal cron loop: when enabled it periodically
 * fires the game-loop entry crons with the CRON_SECRET; otherwise it is a no-op.
 */
describe("startInternalCronLoop", () => {
  let fetchMock: ReturnType<typeof mock>;
  let intervalCallback: (() => void) | undefined;
  let intervalCount = 0;
  let importVersion = 0;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;

  const importCronScheduler = () =>
    import(`./cron-scheduler?test=${importVersion++}`) as Promise<
      typeof import("./cron-scheduler")
    >;

  const flushAsyncTick = async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    intervalCallback = undefined;
    intervalCount = 0;
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCount += 1;
      intervalCallback =
        typeof callback === "function" ? () => callback() : undefined;
      return intervalCount as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.ENABLE_INTERNAL_CRON_SCHEDULER;
    delete process.env.CRON_SECRET;
    delete process.env.INTERNAL_CRON_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    delete process.env.ENABLE_INTERNAL_CRON_SCHEDULER;
    delete process.env.CRON_SECRET;
    delete process.env.INTERNAL_CRON_URL;
  });

  it("is a no-op unless ENABLE_INTERNAL_CRON_SCHEDULER === 'true'", async () => {
    process.env.CRON_SECRET = "s";
    const { startInternalCronLoop } = await importCronScheduler();
    startInternalCronLoop();
    intervalCallback?.();
    await flushAsyncTick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op (and does not throw) when CRON_SECRET is missing", async () => {
    process.env.ENABLE_INTERNAL_CRON_SCHEDULER = "true";
    const { startInternalCronLoop } = await importCronScheduler();
    startInternalCronLoop();
    intervalCallback?.();
    await flushAsyncTick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires the game-loop entry crons every minute with the cron secret", async () => {
    process.env.ENABLE_INTERNAL_CRON_SCHEDULER = "true";
    process.env.CRON_SECRET = "secret-xyz";
    process.env.INTERNAL_CRON_URL = "http://127.0.0.1:8080";
    const { startInternalCronLoop } = await importCronScheduler();
    startInternalCronLoop();

    intervalCallback?.();
    await flushAsyncTick();

    const paths = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain("http://127.0.0.1:8080/api/cron/game-tick");
    expect(paths).toContain("http://127.0.0.1:8080/api/cron/agent-tick");
    expect(paths).toContain("http://127.0.0.1:8080/api/cron/realtime-drain");

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).method).toBe("POST");
      expect(
        (init as { headers: Record<string, string> }).headers.Authorization,
      ).toBe("Bearer secret-xyz");
    }
  });

  it("does not start twice (idempotent)", async () => {
    process.env.ENABLE_INTERNAL_CRON_SCHEDULER = "true";
    process.env.CRON_SECRET = "secret-xyz";
    const { startInternalCronLoop } = await importCronScheduler();
    startInternalCronLoop();
    startInternalCronLoop();
    intervalCallback?.();
    await flushAsyncTick();
    // 3 entry crons fired once (not doubled) for the single 60s tick.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(intervalCount).toBe(1);
  });
});
