/** Exercises Caddy ingress mutations, origin enforcement, and failure handling. */
import { describe, expect, test } from "bun:test";
import { addAppRoute, type IngressFetch, removeAppRoute } from "../apps-ingress-provisioner";

const HOST = "abc12345.apps.elizacloud.ai";
const ADMIN = "http://127.0.0.1:2019";

function recordingFetch(
  responder: (url: string, method: string) => { ok: boolean; status: number },
) {
  const calls: Array<{
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }> = [];
  const fetchImpl: IngressFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    const { ok, status } = responder(url, init.method);
    return { ok, status, text: async () => "" };
  };
  return { calls, fetchImpl };
}

describe("addAppRoute", () => {
  test("deletes any same-id route, then POSTs the built route to the server", async () => {
    const { calls, fetchImpl } = recordingFetch((_u, m) => ({
      ok: true,
      status: m === "DELETE" ? 200 : 201,
    }));
    await addAppRoute({
      hostname: HOST,
      hostPort: 28123,
      adminBase: ADMIN,
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    // 1) idempotent delete by @id
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: "http://127.0.0.1:2019/id/app-abc12345",
      headers: { Origin: ADMIN },
    });
    // 2) POST the route to srv0
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("http://127.0.0.1:2019/config/apps/http/servers/srv0/routes");
    expect(calls[1].headers).toEqual({
      Origin: ADMIN,
      "Content-Type": "application/json",
    });
    const posted = JSON.parse(calls[1].body ?? "{}");
    expect(posted["@id"]).toBe("app-abc12345");
    expect(posted.match[0].host).toEqual([HOST]);
    // dial is node-local loopback (Caddy co-located on the app node)
    expect(posted.handle[0].upstreams[0].dial).toBe("127.0.0.1:28123");
  });

  test("passes a Caddy origin-enforcement boundary on every mutation", async () => {
    const fetchImpl: IngressFetch = async (_url, init) => {
      const accepted = init.headers?.Origin === ADMIN;
      return {
        ok: accepted,
        status: accepted ? 201 : 403,
        text: async () =>
          accepted ? "" : '{"error":"client is not allowed to access from origin \'\'"}',
      };
    };

    await expect(
      addAppRoute({
        hostname: HOST,
        hostPort: 28123,
        adminBase: `${ADMIN}/`,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  test("throws when Caddy rejects the POST (so the deploy fails fast, not a silent 502)", async () => {
    const { fetchImpl } = recordingFetch((_u, m) => ({
      ok: m === "DELETE",
      status: m === "DELETE" ? 200 : 500,
    }));
    await expect(
      addAppRoute({ hostname: HOST, nodeHost: "n", hostPort: 1, adminBase: ADMIN, fetchImpl }),
    ).rejects.toThrow("add-route failed (500) for abc12345.apps.elizacloud.ai via 127.0.0.1:2019");
  });

  test("preserves a route POST transport failure as the typed error cause", async () => {
    const transportError = new Error("caddy post timeout");
    const fetchImpl: IngressFetch = async (_url, init) => {
      if (init.method === "POST") throw transportError;
      return { ok: true, status: 200, text: async () => "" };
    };

    await expect(
      addAppRoute({ hostname: HOST, hostPort: 28123, adminBase: ADMIN, fetchImpl }),
    ).rejects.toMatchObject({
      code: "CADDY_ADMIN_MUTATION_FAILED",
      cause: transportError,
      context: { operation: "add-route" },
    });
  });

  test("surfaces an unreadable Caddy rejection body with its original cause", async () => {
    const bodyError = new Error("response stream aborted");
    const fetchImpl: IngressFetch = async (_url, init) => ({
      ok: init.method === "DELETE",
      status: init.method === "DELETE" ? 200 : 500,
      text: async () => {
        throw bodyError;
      },
    });

    await expect(
      addAppRoute({ hostname: HOST, hostPort: 28123, adminBase: ADMIN, fetchImpl }),
    ).rejects.toMatchObject({
      code: "CADDY_ADMIN_RESPONSE_READ_FAILED",
      cause: bodyError,
    });
  });

  test("fails before POST when stale-route deletion has a transport failure", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: IngressFetch = async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === "DELETE") {
        throw new Error("caddy delete timeout");
      }
      return { ok: true, status: 201, text: async () => "" };
    };

    await expect(
      addAppRoute({
        hostname: HOST,
        hostPort: 28123,
        adminBase: ADMIN,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "CADDY_ADMIN_MUTATION_FAILED",
      context: { operation: "replace-route-delete" },
    });

    expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
  });

  test("fails before POST when Caddy rejects stale-route deletion", async () => {
    const { calls, fetchImpl } = recordingFetch((_url, method) => ({
      ok: method !== "DELETE",
      status: method === "DELETE" ? 403 : 201,
    }));

    await expect(
      addAppRoute({ hostname: HOST, hostPort: 28123, adminBase: ADMIN, fetchImpl }),
    ).rejects.toThrow(
      "replace-route-delete failed (403) for abc12345.apps.elizacloud.ai via 127.0.0.1:2019",
    );

    expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
  });

  test("continues to POST when the stale route is already absent", async () => {
    const { calls, fetchImpl } = recordingFetch((_url, method) => ({
      ok: method === "POST",
      status: method === "DELETE" ? 404 : 201,
    }));

    await addAppRoute({ hostname: HOST, hostPort: 28123, adminBase: ADMIN, fetchImpl });

    expect(calls.map((call) => call.method)).toEqual(["DELETE", "POST"]);
  });

  test("rejects a malformed admin base before making a request", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ ok: true, status: 200 }));
    await expect(
      addAppRoute({ hostname: HOST, hostPort: 28123, adminBase: "not a URL", fetchImpl }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("removeAppRoute", () => {
  test("DELETEs the route by @id", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ ok: true, status: 200 }));
    await removeAppRoute({ hostname: HOST, adminBase: ADMIN, fetchImpl });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:2019/id/app-abc12345",
        method: "DELETE",
        headers: { Origin: ADMIN },
        body: undefined,
      },
    ]);
  });

  test("treats 404 as success (route already gone)", async () => {
    const { fetchImpl } = recordingFetch(() => ({ ok: false, status: 404 }));
    await expect(
      removeAppRoute({ hostname: HOST, adminBase: ADMIN, fetchImpl }),
    ).resolves.toBeUndefined();
  });

  test("throws on a non-404 failure", async () => {
    const { fetchImpl } = recordingFetch(() => ({ ok: false, status: 500 }));
    await expect(removeAppRoute({ hostname: HOST, adminBase: ADMIN, fetchImpl })).rejects.toThrow(
      "remove-route failed (500) for abc12345.apps.elizacloud.ai via 127.0.0.1:2019",
    );
  });

  test("preserves a removal transport failure as the typed error cause", async () => {
    const transportError = new Error("caddy delete timeout");
    const fetchImpl: IngressFetch = async () => {
      throw transportError;
    };

    await expect(
      removeAppRoute({ hostname: HOST, adminBase: ADMIN, fetchImpl }),
    ).rejects.toMatchObject({
      code: "CADDY_ADMIN_MUTATION_FAILED",
      cause: transportError,
      context: { operation: "remove-route" },
    });
  });
});
