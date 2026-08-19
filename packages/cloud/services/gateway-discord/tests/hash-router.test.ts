/** Exercises direct and Kubernetes-backed Discord gateway hash routing with deterministic fetch boundaries. */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as common from "@elizaos/cloud-services-common";
import { getHashTargets, refreshHashRing } from "../src/hash-router";

function endpointSliceResponse(addresses: string[]): Response {
  return Response.json({
    items: addresses.length
      ? [
          {
            endpoints: [
              {
                addresses,
                conditions: { ready: true },
              },
            ],
          },
        ]
      : [],
  });
}

describe("hash router", () => {
  afterEach(() => {
    mock.restore();
  });

  test("uses non-Kubernetes service URLs directly", async () => {
    await expect(
      getHashTargets("http://agent-server.railway.internal:3000", "user-1", 2),
    ).resolves.toEqual(["http://agent-server.railway.internal:3000"]);
  });

  test("preserves direct service base paths", async () => {
    await expect(
      getHashTargets("http://sandbox.example:18791/api", "user-1", 2),
    ).resolves.toEqual(["http://sandbox.example:18791/api"]);
  });

  test("skips hash-ring refreshes for direct service URLs", async () => {
    await expect(
      refreshHashRing("https://agent-server.up.railway.app"),
    ).resolves.toBeUndefined();
  });

  test("uses the exact EndpointSlice timeout signal", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
      timeoutSignal,
    );
    let capturedInit: RequestInit | undefined;
    spyOn(globalThis, "fetch").mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return endpointSliceResponse(["10.0.0.1", "10.0.0.2"]);
      },
    );

    const targets = await getHashTargets(
      "http://timeout-signal.eliza-agents.svc.cluster.local:3000",
      "user-1",
      2,
    );

    expect(targets.length).toBe(2);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(capturedInit?.signal).toBe(timeoutSignal);
  });

  test("handles an aborted EndpointSlice fetch without throwing", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    spyOn(AbortSignal, "timeout").mockReturnValue(
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
    spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return endpointSliceResponse(["10.0.0.1"]);
    });

    await expect(
      getHashTargets(
        "http://aborted-server.eliza-agents.svc.cluster.local:3000",
        "user-1",
        2,
      ),
    ).resolves.toEqual([]);
  });

  test("retains the last known-good ring on discovery failure", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      endpointSliceResponse(["10.0.0.1", "10.0.0.2"]),
    );
    const serverUrl =
      "http://retained-server.eliza-agents.svc.cluster.local:3000";

    const before = await getHashTargets(serverUrl, "user-1", 2);
    fetchSpy.mockRejectedValue(new Error("control plane unavailable"));
    await refreshHashRing(serverUrl);

    await expect(getHashTargets(serverUrl, "user-1", 2)).resolves.toEqual(
      before,
    );
  });

  test("coalesces concurrent stale-ring refreshes without delaying callers", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    const nowSpy = spyOn(Date, "now").mockReturnValue(2_000_000);
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let fetchCalls = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls > 1) await refreshGate;
      return endpointSliceResponse(["10.0.0.1"]);
    });
    const serverUrl =
      "http://concurrent-stale.eliza-agents.svc.cluster.local:3000";
    await getHashTargets(serverUrl, "seed", 1);
    nowSpy.mockReturnValue(2_006_000);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        getHashTargets(serverUrl, `user-${index}`, 1),
      ),
    );

    expect(results.every((targets) => targets.length === 1)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    releaseRefresh?.();
    await refreshHashRing(serverUrl);
  });

  test("coalesces expired-ring refreshes and fails closed", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    const nowSpy = spyOn(Date, "now").mockReturnValue(3_000_000);
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let fetchCalls = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls === 1) return endpointSliceResponse(["10.0.0.1"]);
      await refreshGate;
      throw new Error("control plane unavailable");
    });
    const serverUrl =
      "http://concurrent-expired.eliza-agents.svc.cluster.local:3000";
    await getHashTargets(serverUrl, "seed", 1);
    nowSpy.mockReturnValue(3_030_001);

    const pending = Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        getHashTargets(serverUrl, `user-${index}`, 1),
      ),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    releaseRefresh?.();

    const results = await pending;
    expect(results.every((targets) => targets.length === 0)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("drops a stale ring after prolonged discovery failure", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      endpointSliceResponse(["10.0.0.1"]),
    );
    const serverUrl = "http://stale-server.eliza-agents.svc.cluster.local:3000";

    await expect(getHashTargets(serverUrl, "user-1", 2)).resolves.toHaveLength(
      1,
    );
    nowSpy.mockReturnValue(1_030_001);
    fetchSpy.mockRejectedValue(new Error("control plane unavailable"));

    await expect(getHashTargets(serverUrl, "user-1", 2)).resolves.toEqual([]);
  });

  test("clears the ring after an authoritative empty response", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      endpointSliceResponse(["10.0.0.1"]),
    );
    const serverUrl = "http://empty-server.eliza-agents.svc.cluster.local:3000";

    await expect(getHashTargets(serverUrl, "user-1", 2)).resolves.toHaveLength(
      1,
    );
    fetchSpy.mockImplementation(async () => endpointSliceResponse([]));
    await refreshHashRing(serverUrl);

    await expect(getHashTargets(serverUrl, "user-1", 2)).resolves.toEqual([]);
  });
});
