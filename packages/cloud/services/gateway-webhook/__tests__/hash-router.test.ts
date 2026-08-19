// Exercises the gateway-webhook hash router path with deterministic cloud service fixtures.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as common from "@elizaos/cloud-services-common";
import { getHashTargets, refreshHashRing } from "../src/hash-router";

describe("hash-router direct targets", () => {
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

  test("resolves Kubernetes EndpointSlice with timeout signal", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({
            items: [
              {
                endpoints: [
                  {
                    addresses: ["10.0.0.1", "10.0.0.2"],
                    conditions: { ready: true },
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const targets = await getHashTargets(
      "http://agent-server.eliza-agents.svc.cluster.local:3000",
      "user-1",
      2,
    );

    expect(targets.length).toBe(2);
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("handles EndpointSlice fetch timeout or failure safely without throwing", async () => {
    spyOn(common, "readServiceAccountToken").mockReturnValue("test-token");
    spyOn(common, "readServiceAccountCaCert").mockReturnValue(null);

    globalThis.fetch = mock(async () => {
      throw new Error("EndpointSlice fetch timed out");
    }) as unknown as typeof fetch;

    const targets = await getHashTargets(
      "http://failed-server.eliza-agents.svc.cluster.local:3000",
      "user-1",
      2,
    );

    expect(targets).toEqual([]);
  });
});
