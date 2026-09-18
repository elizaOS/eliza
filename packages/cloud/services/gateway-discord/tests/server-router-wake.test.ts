/** Verifies that direct Discord server targets bypass Kubernetes wake requests. */

import { describe, expect, mock, test } from "bun:test";
import { wakeServer } from "../src/server-router";

const dependencies = {
  getToken: () => "test-token",
  getCaCert: () => "test-ca",
};

describe("gateway-discord wakeServer", () => {
  test("does not contact Kubernetes for a direct server", async () => {
    const fetchFn = mock(async () => new Response(null, { status: 200 }));

    await wakeServer("agent-server", "http://agent.example:3000", {
      ...dependencies,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
