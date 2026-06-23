import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies the single-service internal cron loop: when enabled it periodically
 * fires the game-loop entry crons with the CRON_SECRET; otherwise it is a no-op.
 */
describe("startInternalCronLoop", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    delete process.env.ENABLE_INTERNAL_CRON_SCHEDULER;
    delete process.env.CRON_SECRET;
    delete process.env.INTERNAL_CRON_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.ENABLE_INTERNAL_CRON_SCHEDULER;
    delete process.env.CRON_SECRET;
    delete process.env.INTERNAL_CRON_URL;
  });

  it("is a no-op unless ENABLE_INTERNAL_CRON_SCHEDULER === 'true'", async () => {
    process.env.CRON_SECRET = "s";
    const { startInternalCronLoop } = await import("./cron-scheduler");
    startInternalCronLoop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op (and does not throw) when CRON_SECRET is missing", async () => {
    process.env.ENABLE_INTERNAL_CRON_SCHEDULER = "true";
    const { startInternalCronLoop } = await import("./cron-scheduler");
    startInternalCronLoop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires the game-loop entry crons every minute with the cron secret", async () => {
    process.env.ENABLE_INTERNAL_CRON_SCHEDULER = "true";
    process.env.CRON_SECRET = "secret-xyz";
    process.env.INTERNAL_CRON_URL = "http://127.0.0.1:8080";
    const { startInternalCronLoop } = await import("./cron-scheduler");
    startInternalCronLoop();

    await vi.advanceTimersByTimeAsync(60_000);

    const paths = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain("http://127.0.0.1:8080/api/cron/game-tick");
    expect(paths).toContain("http://127.0.0.1:8080/api/cron/agent-tick");
    expect(paths).toContain("http://127.0.0.1:8080/api/cron/realtime-drain");

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).method).toBe("POST");
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
        "Bearer secret-xyz",
      );
    }
  });

  it("does not start twice (idempotent)", async () => {
    process.env.ENABLE_INTERNAL_CRON_SCHEDULER = "true";
    process.env.CRON_SECRET = "secret-xyz";
    const { startInternalCronLoop } = await import("./cron-scheduler");
    startInternalCronLoop();
    startInternalCronLoop();
    await vi.advanceTimersByTimeAsync(60_000);
    // 3 entry crons fired once (not doubled) for the single 60s tick.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
