/**
 * Exercises the OsAtlasPro actor's deadline and caller-cancellation contract
 * through its injectable HTTP boundary.
 */
import { describe, expect, it } from "vitest";
import { OSATLAS_PRO_TIMEOUT_MS, OsAtlasProActor } from "./actor.js";

const OPTS = { endpoint: "https://osatlas.example/v1" };
const ARGS = {
  displayId: 1,
  croppedImage: Buffer.from("png"),
  hint: "Save",
  ref: "t1-0",
};

function stallUntilAborted(): NonNullable<
  ConstructorParameters<typeof OsAtlasProActor>[0]["fetcher"]
> {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected osatlas abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as NonNullable<
    ConstructorParameters<typeof OsAtlasProActor>[0]["fetcher"]
  >;
}

describe("OsAtlasPro request deadline", () => {
  it("keeps a documented model-server budget", () => {
    expect(OSATLAS_PRO_TIMEOUT_MS).toBe(30_000);
  });

  it("aborts a stalled grounding POST at the injected deadline", async () => {
    const pending = new OsAtlasProActor({
      ...OPTS,
      fetcher: stallUntilAborted(),
      timeoutMs: 10,
    }).ground(ARGS);
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("preserves caller cancellation instead of reclassifying it as a timeout", async () => {
    const controller = new AbortController();
    const reason = new DOMException("turn stopped", "AbortError");
    const pending = new OsAtlasProActor({
      ...OPTS,
      fetcher: stallUntilAborted(),
    }).ground({ ...ARGS, signal: controller.signal });

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("surfaces a provider error from a completed grounding POST", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 503,
      text: async () => "overloaded",
    });

    await expect(
      new OsAtlasProActor({ ...OPTS, fetcher: fetchImpl }).ground(ARGS),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful grounding POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = async (_input: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ x: 12, y: 34, confidence: 0.9 }),
      };
    };

    const result = await new OsAtlasProActor({
      ...OPTS,
      fetcher: fetchImpl,
    }).ground(ARGS);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.x).toBe(12);
    expect(result.y).toBe(34);
    expect(result.confidence).toBe(0.9);
    expect(result.displayId).toBe(1);
    expect(result.reason).toContain("t1-0");
  });
});
