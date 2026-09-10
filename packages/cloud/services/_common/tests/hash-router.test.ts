/** Exercises the shared Cloud hash router with deterministic discovery and ring boundaries. */

import { describe, expect, test } from "bun:test";
import { createHashRouter } from "../src/hash-router";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function endpointSliceResponse(address: string): Response {
  return Response.json({
    items: [
      {
        endpoints: [{ addresses: [address], conditions: { ready: true } }],
      },
    ],
  });
}

describe("shared hash router", () => {
  test("preserves direct targets and their base paths", async () => {
    const router = createHashRouter({
      createRing: (podIPs) => ({ range: () => podIPs }),
      readServiceAccountToken: () => null,
      readServiceAccountCaCert: () => null,
      logger,
    });

    await expect(
      router.getTargets("https://agent.example.test/base", "tenant", 2),
    ).resolves.toEqual(["https://agent.example.test/base"]);
  });

  test("isolates rings for identically named services in different namespaces", async () => {
    const calls: string[] = [];
    const router = createHashRouter({
      createRing: (podIPs) => ({
        range: (_key, count) => podIPs.slice(0, count),
      }),
      readServiceAccountToken: () => "token",
      readServiceAccountCaCert: () => null,
      logger,
      fetch: async (input) => {
        const requestUrl = String(input);
        calls.push(requestUrl);
        const address = requestUrl.includes("/namespaces/alpha/")
          ? "10.0.0.1"
          : "10.0.0.2";
        return endpointSliceResponse(address);
      },
    });

    await expect(
      router.getTargets(
        "http://agent-server.alpha.svc.cluster.local:3000",
        "tenant",
        1,
      ),
    ).resolves.toEqual(["10.0.0.1:3000"]);
    await expect(
      router.getTargets(
        "http://agent-server.beta.svc.cluster.local:3000",
        "tenant",
        1,
      ),
    ).resolves.toEqual(["10.0.0.2:3000"]);
    expect(calls).toHaveLength(2);
  });
});
