// Exercises apps ingress provisioner behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { addAppRoute, type IngressFetch, removeAppRoute } from "../apps-ingress-provisioner";

const HOST = "abc12345.apps.elizacloud.ai";
const ADMIN = "http://127.0.0.1:2019";

function recordingFetch(
  responder: (url: string, method: string) => { ok: boolean; status: number },
) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: IngressFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
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
    });
    // 2) POST the route to srv0
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("http://127.0.0.1:2019/config/apps/http/servers/srv0/routes");
    const posted = JSON.parse(calls[1].body ?? "{}");
    expect(posted["@id"]).toBe("app-abc12345");
    expect(posted.match[0].host).toEqual([HOST]);
    // dial is node-local loopback (Caddy co-located on the app node)
    expect(posted.handle[0].upstreams[0].dial).toBe("127.0.0.1:28123");
  });

  test("throws when Caddy rejects the POST (so the deploy fails fast, not a silent 502)", async () => {
    const { fetchImpl } = recordingFetch((_u, m) => ({
      ok: m === "DELETE",
      status: m === "DELETE" ? 200 : 500,
    }));
    await expect(
      addAppRoute({ hostname: HOST, nodeHost: "n", hostPort: 1, adminBase: ADMIN, fetchImpl }),
    ).rejects.toThrow(/add-route failed \(500\)/);
  });
});

describe("removeAppRoute", () => {
  test("DELETEs the route by @id", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ ok: true, status: 200 }));
    await removeAppRoute({ hostname: HOST, adminBase: ADMIN, fetchImpl });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:2019/id/app-abc12345", method: "DELETE", body: undefined },
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
      /remove-route failed \(500\)/,
    );
  });
});
