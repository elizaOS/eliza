/**
 * Behavioral OsAtlasPro grounding deadline. Executes the default model-server
 * POST under abort — not a source-grep of actor.ts.
 */
import { describe, expect, it } from "vitest";
import { groundOsAtlasProWithFetch, OSATLAS_PRO_TIMEOUT_MS } from "./actor.js";

const OPTS = { endpoint: "https://osatlas.example/v1" };
const ARGS = {
  displayId: 1,
  croppedImage: Buffer.from("png"),
  hint: "Save",
  ref: "t1-0",
};

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected osatlas abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("OsAtlasPro request deadline", () => {
  it("keeps a documented model-server budget", () => {
    expect(OSATLAS_PRO_TIMEOUT_MS).toBe(30_000);
  });

  it("aborts a stalled grounding POST at the injected deadline", async () => {
    await expect(
      groundOsAtlasProWithFetch(OPTS, ARGS, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed grounding POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("overloaded", {
        status: 503,
        statusText: "Service Unavailable",
      });

    await expect(
      groundOsAtlasProWithFetch(OPTS, ARGS, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful grounding POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ x: 12, y: 34, confidence: 0.9 });
    };

    const result = await groundOsAtlasProWithFetch(
      OPTS,
      ARGS,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.x).toBe(12);
    expect(result.y).toBe(34);
    expect(result.confidence).toBe(0.9);
    expect(result.displayId).toBe(1);
    expect(result.reason).toContain("t1-0");
  });
});
