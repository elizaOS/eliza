import { afterEach, describe, expect, it, vi } from "vitest";
import { withMapsNavigationRelay } from "../src/client/navigation-relay";

describe("withMapsNavigationRelay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs a request from an agent host whose clock is ahead of the phone", async () => {
    // The agent host stamps expiresAt with its own clock plus 30 seconds and delivers it at once.
    const hostAheadMs = 250;
    const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    let delivered = false;
    let acknowledge: (body: Record<string, unknown>) => void = () => {};
    const acknowledged = new Promise<Record<string, unknown>>((resolve) => {
      acknowledge = resolve;
    });
    const request = async (
      _path: string,
      body: unknown,
      signal: AbortSignal,
    ) => {
      const message = body as Record<string, unknown>;
      if (message.phase === "result") acknowledge(message);
      if (message.phase === "poll" && !delivered) {
        delivered = true;
        return {
          protocol: 1,
          request: {
            id,
            expiresAt: Date.now() + hostAheadMs + 30_000,
            operation: { kind: "stop" },
          },
        };
      }
      if (message.phase === "poll")
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      return { protocol: 1, request: null };
    };
    const deadlines: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      deadlines.push(ms);
      return timeout(ms);
    });
    const owner = {},
      executed: unknown[] = [];
    const host = {
      current: () => owner,
      execute: async (_owner: object, operation: unknown) => {
        executed.push(operation);
        return { state: "stopped" };
      },
      failure: () => "MAPS_DEVICE_UNAVAILABLE",
      connected() {},
    };
    const result = await withMapsNavigationRelay(
      host,
      request,
      "conversation",
      new AbortController().signal,
      async () =>
        Promise.race([
          acknowledged,
          new Promise((resolve) => setTimeout(resolve, 1_000, "timed out")),
        ]),
    );
    expect(executed).toEqual([{ kind: "stop" }]);
    expect(result).toMatchObject({ id, status: { state: "stopped" } });
    // The phone still gives up after the relay's 30 seconds, whatever the host clock says.
    expect(Math.max(...deadlines)).toBeLessThanOrEqual(30_000);
  });

  it("composes signals through the host when it supplies anySignal", async () => {
    const composed: AbortSignal[][] = [];
    const host = {
      anySignal(signals: AbortSignal[]) {
        composed.push(signals);
        const controller = new AbortController();
        for (const signal of signals)
          signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        return controller.signal;
      },
      current: () => ({}),
      execute: async () => null,
      failure: () => "failed",
      connected() {},
    };
    // A relay that is unavailable falls back to the plain send after composing the lifetime.
    const result = await withMapsNavigationRelay(
      host,
      async () => {
        throw Error("unavailable");
      },
      "conversation",
      new AbortController().signal,
      async () => "sent",
    );
    expect(result).toBe("sent");
    expect(composed).toHaveLength(1);
    expect(composed[0]).toHaveLength(2);
  });
});
