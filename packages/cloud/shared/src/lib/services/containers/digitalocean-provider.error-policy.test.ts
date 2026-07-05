/**
 * Error-policy proof for `DigitalOceanComputeProvider` (#13415).
 *
 * Container-provisioning infra must FAIL CLOSED: an internal cloud-API failure
 * (transport error, 5xx, non-JSON body) must PROPAGATE as a typed
 * `DigitalOceanComputeError`, never collapse into an empty list / null / silent
 * success that reads as "no servers" or "already done". A legitimately-empty
 * result (an actually-empty 200 list, a genuine 404-absent lookup) is the
 * designed shape and must stay DISTINCT from those failures.
 *
 * Unlike the sibling characterization test (which injects a recording fetch via
 * the constructor), this exercises the REAL default production wiring: the
 * zero-arg `new DigitalOceanComputeProvider()` resolves `globalThis.fetch` and
 * the env-backed token getter, so we override `globalThis.fetch` and set
 * `DO_API_TOKEN`, restoring both in `afterEach`. The module is loaded via a
 * dynamic `import()` so the mocked global is in place before construction.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const realFetch = globalThis.fetch;
const savedToken = process.env.DO_API_TOKEN;
const savedAltToken = process.env.DIGITALOCEAN_TOKEN;

/** Queue of responder thunks; each fetch shifts the next (real Response or throw). */
let queue: Array<() => Response | Promise<Response>>;

function queueJson(body: unknown, status = 200): void {
  queue.push(() => new Response(JSON.stringify(body), { status }));
}
function queueRaw(body: string, status: number): void {
  queue.push(() => new Response(body, { status }));
}
function queueReject(message: string): void {
  queue.push(() => {
    throw new Error(message);
  });
}

beforeEach(() => {
  queue = [];
  process.env.DO_API_TOKEN = "do-error-policy-token";
  delete process.env.DIGITALOCEAN_TOKEN;
  globalThis.fetch = mock(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch (no response queued)");
    return next();
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedToken === undefined) delete process.env.DO_API_TOKEN;
  else process.env.DO_API_TOKEN = savedToken;
  if (savedAltToken === undefined) delete process.env.DIGITALOCEAN_TOKEN;
  else process.env.DIGITALOCEAN_TOKEN = savedAltToken;
});

async function loadProvider() {
  const mod = await import("./digitalocean-provider");
  // Zero-arg construction: real default fetch (mocked global) + env token getter.
  return { provider: new mod.DigitalOceanComputeProvider(), Err: mod.DigitalOceanComputeError };
}

describe("DigitalOceanComputeProvider fails closed on internal failures (default wiring)", () => {
  it("listServers PROPAGATES a 5xx instead of reading as an empty fleet", async () => {
    const { provider, Err } = await loadProvider();
    queueJson({ id: "server_error", message: "DO is down" }, 500);

    let caught: unknown;
    try {
      await provider.listServers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Err);
    expect((caught as InstanceType<typeof Err>).code).toBe("server_error");
    expect((caught as InstanceType<typeof Err>).status).toBe(500);
  });

  it("listServers PROPAGATES a transport rejection (never a masked empty list)", async () => {
    const { provider, Err } = await loadProvider();
    queueReject("ECONNRESET");

    const caught = await provider.listServers().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Err);
    expect((caught as InstanceType<typeof Err>).code).toBe("transport_error");
    // The cause chains the underlying network error — the failure is not swallowed.
    expect((caught as InstanceType<typeof Err>).cause).toBeInstanceOf(Error);
  });

  it("listServers PROPAGATES a non-JSON body instead of fabricating a parsed default", async () => {
    const { provider, Err } = await loadProvider();
    queueRaw("<html>502 Bad Gateway</html>", 502);

    const caught = await provider.listServers().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Err);
    expect((caught as InstanceType<typeof Err>).code).toBe("server_error");
    expect((caught as InstanceType<typeof Err>).status).toBe(502);
  });

  it("a genuinely-empty 200 list stays DISTINCT from a failure (designed empty)", async () => {
    const { provider } = await loadProvider();
    queueJson({ droplets: [] }, 200);

    const servers = await provider.listServers();
    expect(servers).toEqual([]);
  });
});

describe("getServer / deleteServer: designed-absent vs surfaced failure", () => {
  it("getServer returns null ONLY for a real 404 (designed absent)", async () => {
    const { provider } = await loadProvider();
    queueJson({ id: "not_found", message: "no such droplet" }, 404);
    expect(await provider.getServer(999)).toBeNull();
  });

  it("getServer THROWS on a 5xx — a failed lookup must not read as absent (null)", async () => {
    const { provider, Err } = await loadProvider();
    queueJson({ id: "server_error", message: "boom" }, 500);

    const caught = await provider.getServer(42).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Err);
    expect((caught as InstanceType<typeof Err>).code).toBe("server_error");
  });

  it("deleteServer resolves on a 404 (idempotent already-gone)", async () => {
    const { provider } = await loadProvider();
    queueJson({ id: "not_found", message: "already gone" }, 404);
    await expect(provider.deleteServer(7)).resolves.toBeUndefined();
  });

  it("deleteServer THROWS on a 5xx — a failed delete must not fake success", async () => {
    const { provider, Err } = await loadProvider();
    queueJson({ id: "server_error", message: "boom" }, 500);

    const caught = await provider.deleteServer(7).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Err);
    expect((caught as InstanceType<typeof Err>).code).toBe("server_error");
  });
});

describe("missing token fails closed before any network call", () => {
  it("a request throws missing_token (no fetch) when the token is absent", async () => {
    delete process.env.DO_API_TOKEN;
    const { provider, Err } = await loadProvider();

    const caught = await provider.listServers().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Err);
    expect((caught as InstanceType<typeof Err>).code).toBe("missing_token");
    // No response was consumed — the guard fired before fetch.
    expect(queue.length).toBe(0);
  });
});
