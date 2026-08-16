/** Verifies the patched Steward SDK reaches the real agent-scoped approvals contract with session authority. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { StewardApiError, StewardClient } from "@stwd/sdk";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Steward SDK agent-scoped pending approvals", () => {
  test("encodes the agent page and prefers the verified bearer over the tenant key", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        ok: true,
        data: {
          approvals: [
            {
              queueId: "approval-2",
              status: "pending",
              requestedAt: "2026-08-15T00:00:00.000Z",
              transaction: { id: "tx-2" },
            },
          ],
          limit: 2,
          offset: 1,
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new StewardClient({
      baseUrl: "https://steward.example",
      apiKey: "tenant-key",
      bearerToken: "verified-session",
      tenantId: "tenant-1",
    });

    await expect(
      client.listPendingApprovals("agent / one", { limit: 2, offset: 1 }),
    ).resolves.toEqual([
      {
        queueId: "approval-2",
        status: "pending",
        requestedAt: "2026-08-15T00:00:00.000Z",
        transaction: { id: "tx-2" },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://steward.example/vault/agent%20%2F%20one/pending?limit=2&offset=1");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer verified-session");
    expect(headers.get("X-Steward-Key")).toBeNull();
    expect(headers.get("X-Steward-Tenant")).toBe("tenant-1");
  });

  test("fails closed when the scoped response omits the approvals page", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: true, data: { limit: 2, offset: 1 } }),
    ) as unknown as typeof fetch;
    const client = new StewardClient({
      baseUrl: "https://steward.example",
      bearerToken: "verified-session",
    });

    await expect(
      client.listPendingApprovals("agent-1", { limit: 2, offset: 1 }),
    ).rejects.toBeInstanceOf(StewardApiError);
  });

  test("fails closed when the scoped response contains a malformed approval", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: true,
        data: {
          approvals: [{ queueId: "approval-1", status: "pending" }],
          limit: 2,
          offset: 0,
        },
      }),
    ) as unknown as typeof fetch;
    const client = new StewardClient({
      baseUrl: "https://steward.example",
      bearerToken: "verified-session",
    });

    await expect(
      client.listPendingApprovals("agent-1", { limit: 2, offset: 0 }),
    ).rejects.toBeInstanceOf(StewardApiError);
  });
});
