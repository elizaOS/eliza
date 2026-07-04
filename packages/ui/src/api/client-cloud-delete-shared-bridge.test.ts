/**
 * Unit coverage for deleting a shared-agent bridge via the cloud client.
 * Capacitor mocked, no live cloud.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches deleteSharedBridgeAgent onto the prototype.
import "./client-cloud";

/**
 * `deleteSharedBridgeAgent` is the handoff's one DESTRUCTIVE op (it removes the
 * shared `agent_sandboxes` row + cascaded history), so its contract is pinned
 * directly here rather than only through the controller. Three invariants:
 *   1. it hits the EXPLICIT `cloudApiBase`, never the client's `baseUrl` (which
 *      the handoff has already repointed onto the dedicated container);
 *   2. a non-2xx response maps to `{ success: false }` — never throws;
 *   3. a network error resolves to `{ success: false }` — never rejects.
 */

// A base that is NOT an eliza-cloud host, so resolveDirectCloudAuthApiBase
// returns it verbatim — letting us assert the exact origin the DELETE targets.
const EXPLICIT_CLOUD_BASE = "https://cloud.example.test";

function makeClient(): ElizaClient {
  const client = Object.create(ElizaClient.prototype) as ElizaClient;
  // The post-handoff client base points at the dedicated container (baseUrl is
  // a getter over _baseUrl). The delete must IGNORE this and use
  // options.cloudApiBase instead.
  Object.assign(client, { _baseUrl: "https://dedicated-9.elizacloud.ai" });
  return client;
}

describe("deleteSharedBridgeAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pins the DELETE to the explicit cloudApiBase, not the repointed client baseUrl", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient();
    const res = await client.deleteSharedBridgeAgent("shared agent/77", {
      cloudApiBase: EXPLICIT_CLOUD_BASE,
      authToken: "tok-abc",
    });

    expect(res).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    // Origin is the explicit cloud base — NOT the dedicated client baseUrl.
    expect(url.startsWith(`${EXPLICIT_CLOUD_BASE}/api/v1/eliza/agents/`)).toBe(
      true,
    );
    expect(url).not.toContain("dedicated-9.elizacloud.ai");
    // The agent id is URL-encoded into the path.
    expect(url).toContain(encodeURIComponent("shared agent/77"));
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-abc",
    );
  });

  it("maps a non-2xx response to { success: false } without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 500 }) as Response),
    );

    const client = makeClient();
    const res = await client.deleteSharedBridgeAgent("shared-1", {
      cloudApiBase: EXPLICIT_CLOUD_BASE,
      authToken: "tok",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("500");
  });

  it("resolves (never rejects) to { success: false } on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const client = makeClient();
    const res = await client.deleteSharedBridgeAgent("shared-1", {
      cloudApiBase: EXPLICIT_CLOUD_BASE,
      authToken: "tok",
    });

    expect(res).toEqual({ success: false, error: "network down" });
  });
});
