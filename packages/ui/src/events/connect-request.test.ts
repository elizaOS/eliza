/** Exercises real DOM connection handoff, owner completion, and serialized singleton adoption. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_EVENT,
  type ConnectRequestResult,
  dispatchConnectRequest,
  listenForConnectRequests,
} from "./index";

const cleanups: Array<() => void> = [];
const connected = (): ConnectRequestResult => ({ status: "connected" });
function deferred() {
  let resolve!: (result: ConnectRequestResult) => void;
  const promise = new Promise<ConnectRequestResult>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("connect request handoff", () => {
  it("replays before mount and resolves only after the real owner completes", async () => {
    const completion = deferred();
    const listener = vi.fn(() => completion.promise);
    const result = dispatchConnectRequest({
      gatewayUrl: "http://127.0.0.1:31337",
      completeFirstRun: true,
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    cleanups.push(listenForConnectRequests(listener));
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]).toEqual([
      { gatewayUrl: "http://127.0.0.1:31337", completeFirstRun: true },
    ]);
    expect(settled).toBe(false);
    completion.resolve(connected());
    await expect(result).resolves.toEqual(connected());
  });

  it("lets only one startup/shell owner claim a request", async () => {
    const startup = vi.fn(connected);
    const shell = vi.fn(connected);
    cleanups.push(
      listenForConnectRequests(startup),
      listenForConnectRequests(shell),
    );
    await expect(
      dispatchConnectRequest({ gatewayUrl: "https://agent.example.com" }),
    ).resolves.toEqual(connected());
    expect(startup).toHaveBeenCalledOnce();
    expect(shell).not.toHaveBeenCalled();
  });

  it("serializes A then latest C, settles replaced B, and survives owner remount", async () => {
    const a = deferred();
    const calls: string[] = [];
    const stopStartup = listenForConnectRequests((detail) => {
      calls.push(detail.gatewayUrl);
      return a.promise;
    });
    cleanups.push(stopStartup);
    const resultA = dispatchConnectRequest({ gatewayUrl: "https://a.example" });
    const resultB = dispatchConnectRequest({ gatewayUrl: "https://b.example" });
    const resultC = dispatchConnectRequest({ gatewayUrl: "https://c.example" });
    await expect(resultB).resolves.toEqual({ status: "superseded" });
    expect(calls).toEqual(["https://a.example"]);
    stopStartup();
    a.resolve({ status: "failed", message: "A is paused" });
    await expect(resultA).resolves.toEqual({
      status: "failed",
      message: "A is paused",
    });
    await Promise.resolve();
    expect(calls).toEqual(["https://a.example"]);
    cleanups.push(
      listenForConnectRequests((detail) => {
        calls.push(detail.gatewayUrl);
        return connected();
      }),
    );
    const duplicateOwner = vi.fn(connected);
    cleanups.push(listenForConnectRequests(duplicateOwner));
    await expect(resultC).resolves.toEqual(connected());
    expect(calls).toEqual(["https://a.example", "https://c.example"]);
    expect(duplicateOwner).not.toHaveBeenCalled();
  });

  it.each(["sync", "async", "cancel", "unconfirmed"] as const)(
    "releases the active slot after %s owner outcome",
    async (mode) => {
      let calls = 0;
      cleanups.push(
        listenForConnectRequests(() => {
          calls++;
          if (calls > 1) return connected();
          if (mode === "sync") throw new Error("Host unavailable");
          if (mode === "async")
            return Promise.reject(new Error("Host unavailable"));
          if (mode === "cancel") return { status: "cancelled" };
          return undefined;
        }),
      );
      const first = dispatchConnectRequest({ gatewayUrl: "https://a.example" });
      const second = dispatchConnectRequest({
        gatewayUrl: "https://b.example",
      });
      expect((await first).status).toBe(
        mode === "cancel" ? "cancelled" : "failed",
      );
      await expect(second).resolves.toEqual(connected());
      expect(calls).toBe(2);
    },
  );

  it("deduplicates a legacy DOM request while retaining a following dispatch", async () => {
    const completion = deferred();
    const listener = vi
      .fn()
      .mockReturnValueOnce(completion.promise)
      .mockImplementation(connected);
    cleanups.push(listenForConnectRequests(listener));
    const detail = { gatewayUrl: "https://legacy.example" };
    document.dispatchEvent(new CustomEvent(CONNECT_EVENT, { detail }));
    document.dispatchEvent(new CustomEvent(CONNECT_EVENT, { detail }));
    const next = dispatchConnectRequest({ gatewayUrl: "https://next.example" });
    expect(listener).toHaveBeenCalledOnce();
    completion.resolve(connected());
    await expect(next).resolves.toEqual(connected());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
