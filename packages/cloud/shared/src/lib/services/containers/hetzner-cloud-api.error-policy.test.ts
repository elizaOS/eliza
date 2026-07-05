/**
 * Error-policy pins for the Hetzner Cloud API client (#13415).
 *
 * Container-provisioning infra must FAIL CLOSED: a failed create/delete/list
 * cloud-API call has to surface as a typed `HetznerCloudError`, never read as
 * "no servers" / "success". This suite drives the real exported client (fetch
 * stubbed at `globalThis.fetch`) and proves two things stay distinguishable:
 *   - an internal failure (5xx, transport reject, non-JSON body) PROPAGATES;
 *   - a legitimately-empty 200 (`{servers: []}`) and the designed not_found→null
 *     degrade do NOT get conflated with that failure.
 *
 * `mock.module` neutralises the logger + env dependencies so the module under
 * test loads hermetically; it is then pulled in via dynamic `import()`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module("../../config/containers-env", () => ({
  containersEnv: { hetznerCloudToken: () => "" },
}));

type ClientModule = typeof import("./hetzner-cloud-api");

const TOKEN = "test-token-xyz";

let responseQueue: Array<() => Response | Promise<Response>> = [];
let originalFetch: typeof globalThis.fetch;

function queueJson(body: unknown, status = 200): void {
  responseQueue.push(() => new Response(JSON.stringify(body), { status }));
}
function queueRaw(bodyText: string, status: number): void {
  responseQueue.push(() => new Response(bodyText, { status }));
}
function queueReject(err: Error): void {
  responseQueue.push(() => {
    throw err;
  });
}

async function load(): Promise<ClientModule> {
  return import("./hetzner-cloud-api");
}

beforeEach(() => {
  responseQueue = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    const next = responseQueue.shift();
    if (!next) throw new Error("no response queued");
    return next();
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("hetzner-cloud-api fail-closed on internal failure", () => {
  test("listServers on a 500 REJECTS with server_error — a failed list never reads as empty", async () => {
    const { HetznerCloudClient } = await load();
    queueJson({ error: { code: "server_error", message: "boom" } }, 500);

    const promise = HetznerCloudClient.withToken(TOKEN).listServers();
    await expect(promise).rejects.toMatchObject({
      name: "HetznerCloudError",
      code: "server_error",
      status: 500,
    });
  });

  test("listServers on a transport reject REJECTS with transport_error carrying the cause", async () => {
    const { HetznerCloudClient } = await load();
    const boom = new Error("ECONNREFUSED");
    queueReject(boom);

    try {
      await HetznerCloudClient.withToken(TOKEN).listServers();
      throw new Error("expected listServers to reject");
    } catch (err) {
      const e = err as InstanceType<ClientModule["HetznerCloudError"]>;
      expect(e.name).toBe("HetznerCloudError");
      expect(e.code).toBe("transport_error");
      // cause is preserved so the transport boundary does not swallow context.
      expect(e.cause).toBe(boom);
    }
  });

  test("createServer on a 500 REJECTS — provisioning failure never fabricates a server", async () => {
    const { HetznerCloudClient } = await load();
    queueJson({ error: { code: "server_error", message: "capacity" } }, 500);

    await expect(
      HetznerCloudClient.withToken(TOKEN).createServer({
        name: "n1",
        serverType: "cax21",
        location: "fsn1",
        image: "ubuntu-24.04",
        userData: "#cloud-config\n",
      }),
    ).rejects.toMatchObject({ code: "server_error" });
  });

  test("deleteServer on a 500 REJECTS — a failed delete never reads as success", async () => {
    const { HetznerCloudClient } = await load();
    queueJson({ error: { code: "server_error", message: "nope" } }, 500);

    await expect(HetznerCloudClient.withToken(TOKEN).deleteServer(7)).rejects.toMatchObject({
      code: "server_error",
    });
  });

  test("a non-JSON error body REJECTS with server_error — malformed upstream surfaces, not swallowed", async () => {
    const { HetznerCloudClient } = await load();
    queueRaw("<html>502 Bad Gateway</html>", 502);

    await expect(HetznerCloudClient.withToken(TOKEN).listVolumes()).rejects.toMatchObject({
      code: "server_error",
      status: 502,
    });
  });

  test("a 403 quota body maps to quota_exceeded, kept DISTINCT from missing_token", async () => {
    const { HetznerCloudClient } = await load();
    queueJson({ error: { code: "limit_reached", message: "server cap hit" } }, 403);

    await expect(HetznerCloudClient.withToken(TOKEN).listServers()).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });
});

describe("hetzner-cloud-api designed-empty stays distinct from failure", () => {
  test("listServers on a 200 empty list returns [] (empty, no throw)", async () => {
    const { HetznerCloudClient } = await load();
    queueJson({ servers: [] });

    const servers = await HetznerCloudClient.withToken(TOKEN).listServers();
    expect(servers).toEqual([]);
  });

  test("getServer 404 returns null (designed absent) but getServer 500 THROWS (internal failure)", async () => {
    const { HetznerCloudClient } = await load();

    // Expected not_found shape degrades to a null absent-signal.
    queueJson({ error: { code: "not_found", message: "gone" } }, 404);
    const absent = await HetznerCloudClient.withToken(TOKEN).getServer(999);
    expect(absent).toBeNull();

    // A 500 on the SAME method must NOT collapse into that same null.
    queueJson({ error: { code: "server_error", message: "boom" } }, 500);
    await expect(HetznerCloudClient.withToken(TOKEN).getServer(999)).rejects.toMatchObject({
      code: "server_error",
    });
  });

  test("getVolume 404 returns null but getVolume transport-reject THROWS", async () => {
    const { HetznerCloudClient } = await load();

    queueJson({ error: { code: "not_found", message: "gone" } }, 404);
    expect(await HetznerCloudClient.withToken(TOKEN).getVolume(5)).toBeNull();

    queueReject(new Error("ETIMEDOUT"));
    await expect(HetznerCloudClient.withToken(TOKEN).getVolume(5)).rejects.toMatchObject({
      code: "transport_error",
    });
  });
});
