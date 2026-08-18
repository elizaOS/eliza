/**
 * Behavioral Stagehand probe vs command deadlines. Executes health GET and
 * command POST under abort — not a source-grep of stagehand-target.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { debug: vi.fn(), info: vi.fn() },
}));

import {
  executeStagehandCommandWithFetch,
  probeStagehandWithFetch,
  resolveStagehandCommandTimeoutMs,
  STAGEHAND_COMMAND_TIMEOUT_GRACE_MS,
  STAGEHAND_COMMAND_TIMEOUT_MS,
  STAGEHAND_PROBE_TIMEOUT_MS,
} from "./stagehand-target.js";

const HEALTH_URL = "https://stagehand.example/health";
const COMMAND_URL = "https://stagehand.example/api/browser-command";
const COMMAND = { subaction: "state" as const };

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected stagehand abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("Stagehand probe vs command deadlines", () => {
  it("keeps a short probe budget separate from the longer command hop", () => {
    expect(STAGEHAND_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(STAGEHAND_COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(STAGEHAND_PROBE_TIMEOUT_MS).toBeLessThan(
      STAGEHAND_COMMAND_TIMEOUT_MS,
    );
  });

  it("extends the transport deadline for a command with a longer timeout", () => {
    expect(
      resolveStagehandCommandTimeoutMs({
        subaction: "wait",
        timeoutMs: 60_000,
      }),
    ).toBe(60_000 + STAGEHAND_COMMAND_TIMEOUT_GRACE_MS);
    expect(resolveStagehandCommandTimeoutMs(COMMAND)).toBe(
      STAGEHAND_COMMAND_TIMEOUT_MS,
    );
  });

  it("treats a stalled health probe as unavailable after the injected deadline", async () => {
    await expect(
      probeStagehandWithFetch(HEALTH_URL, stallUntilAborted(), 10),
    ).resolves.toBe(false);
  });

  it("treats a completed health probe error as unavailable", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("", { status: 503, statusText: "Service Unavailable" });

    await expect(
      probeStagehandWithFetch(HEALTH_URL, fetchImpl, 1_000),
    ).resolves.toBe(false);
  });

  it("uses the injected fetch for a successful health probe", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("ok", { status: 200 });
    };

    await expect(
      probeStagehandWithFetch(HEALTH_URL, fetchImpl, 1_000),
    ).resolves.toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("aborts a stalled command POST at the injected deadline", async () => {
    await expect(
      executeStagehandCommandWithFetch(
        COMMAND_URL,
        COMMAND,
        stallUntilAborted(),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed command POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: "stagehand busy" }, { status: 502 });

    await expect(
      executeStagehandCommandWithFetch(COMMAND_URL, COMMAND, fetchImpl, 1_000),
    ).rejects.toThrow("stagehand busy");
  });

  it("uses the injected fetch for a successful command POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        result: { mode: "cloud", subaction: "state", value: "ready" },
      });
    };

    const result = await executeStagehandCommandWithFetch(
      COMMAND_URL,
      COMMAND,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.mode).toBe("cloud");
    expect(result.subaction).toBe("state");
    expect(result.value).toBe("ready");
  });
});
