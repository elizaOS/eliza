/**
 * Unit test for `DigitalOceanComputeProvider` — the DO implementation of the
 * `ComputeProvider` IaaS seam.
 *
 * Purpose: pin the *observable wire behavior* of the DO provider — the exact
 * endpoints, HTTP methods, request payloads (camelCase → DO snake_case remap),
 * the status-vocabulary normalization (DO → Hetzner vocabulary), the error-code
 * mapping, the 404==success delete contract, and the `waitForAction` polling
 * loop — all WITHOUT any real network.
 *
 * Construction is fully injectable, so unlike the Hetzner characterization test
 * we do NOT monkey-patch `globalThis.fetch`; we inject a recording stub via the
 * constructor (`{ fetch, tokenGetter, sleep }`). The stub returns real
 * `Response` objects so `.ok` / `.status` / `.text()` semantics match production.
 *
 * Gotchas pinned by construction:
 *  - `mapDroplet` runs the DO status through `mapDropletStatus`, so a freshly
 *    created droplet (`new`) surfaces `status:"initializing"` (NOT `"new"`),
 *    with `rawStatus:"new"` preserving the provider value.
 *  - The JSON body is parsed BEFORE status→code mapping, so every error fixture
 *    body is valid JSON (matching DO's `{ id, message }` envelope).
 *  - `waitForAction` sleeps between polls (injected to a no-op here) and the
 *    loop predicate is `while raw === "in-progress"`. To exercise the loop we
 *    queue exactly `[in-progress, completed]`; for the timeout branch we pass
 *    `timeoutMs: 0` so the deadline is already past (zero fetches).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CreateServerInput,
  type CreateVolumeInput,
  getComputeProvider,
  isComputeConfigured,
} from "./compute-provider";
import {
  DigitalOceanComputeError,
  DigitalOceanComputeProvider,
  type DigitalOceanComputeProviderOptions,
  mapActionStatus,
  mapDropletStatus,
} from "./digitalocean-provider";
import { HetznerCloudClient } from "./hetzner-cloud-api";

const API_BASE = "https://api.digitalocean.com/v2";
const TOKEN = "do-test-token-abc";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A self-contained recording fetch stub + a provider wired to it. Each fetch
 * call shifts the next queued response; assertions read `recorded`.
 */
interface Harness {
  provider: DigitalOceanComputeProvider;
  recorded: RecordedRequest[];
  queueJson(body: unknown, status?: number): void;
  queueStatus(status: number, body?: unknown): void;
  queueRaw(body: string, status: number): void;
  queueReject(message: string): void;
  lastRequest(): RecordedRequest;
}

function makeHarness(
  options: Partial<DigitalOceanComputeProviderOptions> & { token?: string | undefined } = {},
): Harness {
  const recorded: RecordedRequest[] = [];
  const responseQueue: Array<() => Response | Promise<Response>> = [];

  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    recorded.push({ url, method: init?.method ?? "GET", headers, body });
    const next = responseQueue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url} (no response queued)`);
    return next();
  }) as unknown as typeof globalThis.fetch;

  const hasToken = !("token" in options) || options.token !== undefined;
  const token = "token" in options ? options.token : TOKEN;

  const provider = new DigitalOceanComputeProvider({
    fetch: stub,
    tokenGetter: () => (hasToken ? token : undefined),
    apiBase: API_BASE,
    sleep: async () => {},
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });

  return {
    provider,
    recorded,
    queueJson(body: unknown, status = 200) {
      responseQueue.push(() => new Response(JSON.stringify(body), { status }));
    },
    queueStatus(status: number, body?: unknown) {
      responseQueue.push(
        () => new Response(body === undefined ? "" : JSON.stringify(body), { status }),
      );
    },
    queueRaw(body: string, status: number) {
      responseQueue.push(() => new Response(body, { status }));
    },
    queueReject(message: string) {
      responseQueue.push(() => {
        throw new Error(message);
      });
    },
    lastRequest() {
      const req = recorded.at(-1);
      if (!req) throw new Error("no request was recorded");
      return req;
    },
  };
}

// ---------------------------------------------------------------------------
// Public surface — implements ComputeProvider
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider public surface", () => {
  test("exposes the full ComputeProvider method set", () => {
    const { provider } = makeHarness();
    const methods = [
      "listServers",
      "getServer",
      "createServer",
      "deleteServer",
      "powerOff",
      "powerOn",
      "listVolumes",
      "getVolume",
      "createVolume",
      "attachVolume",
      "detachVolume",
      "deleteVolume",
      "waitForAction",
      "listServerTypes",
      "listLocations",
      "listImages",
    ] as const;
    for (const m of methods) {
      expect(typeof (provider as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });

  test("withToken rejects an empty token with missing_token", () => {
    expect(() => DigitalOceanComputeProvider.withToken("")).toThrow(DigitalOceanComputeError);
    try {
      DigitalOceanComputeProvider.withToken("");
    } catch (err) {
      expect((err as DigitalOceanComputeError).code).toBe("missing_token");
    }
  });
});

// ---------------------------------------------------------------------------
// Transport invariants — token, base URL, content-type
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider transport", () => {
  test("sends Bearer auth + JSON content-type to the DO v2 base", async () => {
    const h = makeHarness();
    h.queueJson({ droplets: [] });
    await h.provider.listServers();

    const req = h.lastRequest();
    expect(req.url).toBe(`${API_BASE}/droplets?per_page=200`);
    expect(req.method).toBe("GET");
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["Content-Type"]).toBe("application/json");
  });

  test("a request fires missing_token (no fetch) when the token getter is empty", async () => {
    const h = makeHarness({ token: undefined });
    await expect(h.provider.listServers()).rejects.toMatchObject({ code: "missing_token" });
    // No fetch was attempted.
    expect(h.recorded.length).toBe(0);
  });

  test("a transport-level fetch rejection maps to transport_error", async () => {
    const h = makeHarness();
    h.queueReject("ECONNREFUSED");
    await expect(h.provider.listServers()).rejects.toMatchObject({ code: "transport_error" });
  });

  test("a 204 No Content maps to undefined (delete path)", async () => {
    const h = makeHarness();
    h.queueStatus(204);
    const result = await h.provider.deleteServer(7);
    expect(result).toBeUndefined();
    expect(h.lastRequest().method).toBe("DELETE");
    expect(h.lastRequest().url).toBe(`${API_BASE}/droplets/7`);
  });
});

// ---------------------------------------------------------------------------
// Servers (droplets) — request construction + response mapping
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider servers", () => {
  test("listServers sends per_page; first label value becomes tag_name; rest filtered client-side", async () => {
    const h = makeHarness();
    h.queueJson({
      droplets: [
        { id: 1, name: "a", status: "active", created_at: "t", tags: ["pool", "arm"] },
        { id: 2, name: "b", status: "active", created_at: "t", tags: ["pool"] },
      ],
    });
    const servers = await h.provider.listServers({ role: "pool", arch: "arm" });

    // Server-side filter is the FIRST label value only.
    expect(h.lastRequest().url).toBe(`${API_BASE}/droplets?per_page=200&tag_name=pool`);
    // Client-side filter requires ALL label values present in tags → only id 1.
    expect(servers.map((s) => s.id)).toEqual([1]);
  });

  test("getServer maps the droplet and normalizes status + IPs", async () => {
    const h = makeHarness();
    h.queueJson({
      droplet: {
        id: 42,
        name: "node-a",
        status: "active",
        created_at: "2026-06-03T00:00:00Z",
        networks: {
          v4: [
            { ip_address: "10.0.0.5", type: "private" },
            { ip_address: "203.0.113.7", type: "public" },
          ],
        },
        tags: ["managed"],
      },
    });
    const server = await h.provider.getServer(42);
    expect(h.lastRequest().url).toBe(`${API_BASE}/droplets/42`);
    expect(server).toMatchObject({
      id: 42,
      name: "node-a",
      status: "running", // active → running
      rawStatus: "active",
      created: "2026-06-03T00:00:00Z",
      publicIp: "203.0.113.7",
      privateIp: "10.0.0.5",
    });
    expect(server?.labels).toEqual({ managed: "managed" });
  });

  test("getServer returns null on a 404 DO envelope (does not throw)", async () => {
    const h = makeHarness();
    h.queueStatus(404, { id: "not_found", message: "no such droplet" });
    expect(await h.provider.getServer(999)).toBeNull();
  });

  test("createServer remaps camelCase input to the DO wire body", async () => {
    const h = makeHarness();
    h.queueJson({ droplet: { id: 100, name: "n1", status: "new", created_at: "t" } });
    const input: CreateServerInput = {
      name: "n1",
      serverType: "s-2vcpu-2gb",
      location: "nyc1",
      image: "docker-24-04",
      userData: "#cloud-config\n",
      sshKeyIds: [11, 22],
      networkIds: [33],
      labels: { purpose: "test", tier: "burst" },
    };
    const result = await h.provider.createServer(input);

    const req = h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API_BASE}/droplets`);
    expect(req.body).toEqual({
      name: "n1",
      region: "nyc1", // location → region
      size: "s-2vcpu-2gb", // serverType → size
      image: "docker-24-04", // non-digit slug stays a string
      user_data: "#cloud-config\n", // userData → user_data
      ssh_keys: [11, 22], // sshKeyIds → ssh_keys
      tags: ["test", "burst"], // labels VALUES → tags
      vpc_uuid: "33", // networkIds[0] → vpc_uuid (String)
    });
    // DO never returns a root password; status normalized new → initializing.
    expect(result.rootPassword).toBeNull();
    expect(result.server).toMatchObject({ id: 100, status: "initializing", rawStatus: "new" });
  });

  test("createServer coerces an all-digits image string to a numeric id", async () => {
    const h = makeHarness();
    h.queueJson({ droplet: { id: 101, name: "n2", status: "new", created_at: "t" } });
    await h.provider.createServer({
      name: "n2",
      serverType: "s-1vcpu-1gb",
      location: "nyc1",
      image: "123456789",
      userData: "x",
    });
    expect((h.lastRequest().body as { image: unknown }).image).toBe(123456789);
  });

  test("createServer omits ssh_keys/tags/vpc_uuid when not provided", async () => {
    const h = makeHarness();
    h.queueJson({ droplet: { id: 102, name: "n3", status: "new", created_at: "t" } });
    await h.provider.createServer({
      name: "n3",
      serverType: "s-1vcpu-1gb",
      location: "nyc1",
      image: "docker-24-04",
      userData: "x",
    });
    expect(h.lastRequest().body).toEqual({
      name: "n3",
      region: "nyc1",
      size: "s-1vcpu-1gb",
      image: "docker-24-04",
      user_data: "x",
    });
  });

  test("createServer rejects userData > 64 KiB BEFORE any fetch", async () => {
    const h = makeHarness();
    const big = "a".repeat(64 * 1024 + 1);
    await expect(
      h.provider.createServer({
        name: "n4",
        serverType: "s-1vcpu-1gb",
        location: "nyc1",
        image: "docker-24-04",
        userData: big,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.recorded.length).toBe(0);
  });

  test("deleteServer 404 == success (resolves undefined, never throws)", async () => {
    const h = makeHarness();
    h.queueStatus(404, { id: "not_found", message: "already gone" });
    await expect(h.provider.deleteServer(7)).resolves.toBeUndefined();
    expect(h.lastRequest().method).toBe("DELETE");
    expect(h.lastRequest().url).toBe(`${API_BASE}/droplets/7`);
  });

  test("deleteServer rethrows non-404 errors", async () => {
    const h = makeHarness();
    h.queueStatus(500, { id: "server_error", message: "boom" });
    await expect(h.provider.deleteServer(7)).rejects.toMatchObject({ code: "server_error" });
  });

  test("powerOff / powerOn POST a droplet action and map the action status", async () => {
    const h = makeHarness();
    h.queueJson({ action: { id: 5, status: "in-progress", type: "power_off" } });
    const off = await h.provider.powerOff(7);
    expect(h.lastRequest().method).toBe("POST");
    expect(h.lastRequest().url).toBe(`${API_BASE}/droplets/7/actions`);
    expect(h.lastRequest().body).toEqual({ type: "power_off" });
    expect(off).toMatchObject({ id: 5, command: "power_off", status: "running" }); // in-progress → running

    h.queueJson({ action: { id: 6, status: "in-progress", type: "power_on" } });
    await h.provider.powerOn(7);
    expect(h.lastRequest().body).toEqual({ type: "power_on" });
  });
});

// ---------------------------------------------------------------------------
// Volumes — request construction + mapping + detach lookup
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider volumes", () => {
  test("createVolume remaps sizeGb → size_gigabytes and defaults filesystem_type ext4", async () => {
    const h = makeHarness();
    h.queueJson({
      volume: {
        id: "vol-uuid-1",
        name: "v1",
        size_gigabytes: 50,
        region: { slug: "nyc1", name: "NYC1" },
        droplet_ids: [],
      },
    });
    const input: CreateVolumeInput = { name: "v1", sizeGb: 50, location: "nyc1" };
    const vol = await h.provider.createVolume(input);

    const req = h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API_BASE}/volumes`);
    expect(req.body).toEqual({
      name: "v1",
      size_gigabytes: 50,
      region: "nyc1",
      filesystem_type: "ext4",
    });
    // Volume id is a UUID string; mapped to status "available", server null.
    expect(vol).toMatchObject({
      id: "vol-uuid-1",
      name: "v1",
      size: 50,
      server: null,
      status: "available",
    });
  });

  test("createVolume honors format + labels (tags)", async () => {
    const h = makeHarness();
    h.queueJson({
      volume: {
        id: "vol-uuid-2",
        name: "v2",
        size_gigabytes: 10,
        region: { slug: "ams3", name: "AMS3" },
        droplet_ids: [],
      },
    });
    await h.provider.createVolume({
      name: "v2",
      sizeGb: 10,
      location: "ams3",
      format: "xfs",
      labels: { tier: "data" },
    });
    expect(h.lastRequest().body).toEqual({
      name: "v2",
      size_gigabytes: 10,
      region: "ams3",
      filesystem_type: "xfs",
      tags: ["data"],
    });
  });

  test("listVolumes sends region server-side and filters labels client-side", async () => {
    const h = makeHarness();
    h.queueJson({
      volumes: [
        {
          id: "a",
          name: "a",
          size_gigabytes: 5,
          region: { slug: "nyc1", name: "NYC1" },
          droplet_ids: [],
          tags: ["data"],
        },
        {
          id: "b",
          name: "b",
          size_gigabytes: 5,
          region: { slug: "nyc1", name: "NYC1" },
          droplet_ids: [],
          tags: [],
        },
      ],
    });
    const result = await h.provider.listVolumes({ location: "nyc1", label: { t: "data" } });
    expect(h.lastRequest().url).toBe(`${API_BASE}/volumes?per_page=200&region=nyc1`);
    expect(result.map((v) => v.id)).toEqual(["a"]);
  });

  test("getVolume maps droplet_ids[0] → server and returns null on 404", async () => {
    const h = makeHarness();
    h.queueJson({
      volume: {
        id: "vol-x",
        name: "x",
        size_gigabytes: 20,
        region: { slug: "nyc1", name: "NYC1" },
        droplet_ids: [77],
      },
    });
    const vol = await h.provider.getVolume("vol-x");
    expect(h.lastRequest().url).toBe(`${API_BASE}/volumes/vol-x`);
    expect(vol).toMatchObject({ id: "vol-x", server: 77, status: "available" });

    h.queueStatus(404, { id: "not_found", message: "gone" });
    expect(await h.provider.getVolume("missing")).toBeNull();
  });

  test("attachVolume POSTs {type:attach, droplet_id} to the volume actions endpoint", async () => {
    const h = makeHarness();
    h.queueJson({ action: { id: 9, status: "in-progress", type: "attach" } });
    const action = await h.provider.attachVolume("vol-9", "77");
    const req = h.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API_BASE}/volumes/vol-9/actions`);
    expect(req.body).toEqual({ type: "attach", droplet_id: 77 }); // String serverId coerced to Number
    expect(action).toMatchObject({ id: 9, status: "running" });
  });

  test("detachVolume looks up the current droplet, then POSTs detach", async () => {
    const h = makeHarness();
    // First call: getVolume to learn the attached droplet id.
    h.queueJson({
      volume: {
        id: "vol-d",
        name: "d",
        size_gigabytes: 5,
        region: { slug: "nyc1", name: "NYC1" },
        droplet_ids: [88],
      },
    });
    // Second call: the detach action.
    h.queueJson({ action: { id: 10, status: "in-progress", type: "detach" } });

    const action = await h.provider.detachVolume("vol-d");
    expect(h.recorded[0]?.url).toBe(`${API_BASE}/volumes/vol-d`);
    expect(h.recorded[0]?.method).toBe("GET");
    const detachReq = h.recorded[1];
    expect(detachReq?.method).toBe("POST");
    expect(detachReq?.url).toBe(`${API_BASE}/volumes/vol-d/actions`);
    expect(detachReq?.body).toEqual({ type: "detach", droplet_id: 88 });
    expect(action).toMatchObject({ id: 10, status: "running" });
  });

  test("detachVolume throws invalid_input when the volume is unattached", async () => {
    const h = makeHarness();
    h.queueJson({
      volume: {
        id: "vol-free",
        name: "free",
        size_gigabytes: 5,
        region: { slug: "nyc1", name: "NYC1" },
        droplet_ids: [],
      },
    });
    await expect(h.provider.detachVolume("vol-free")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  test("deleteVolume 404 == success", async () => {
    const h = makeHarness();
    h.queueStatus(404, { id: "not_found", message: "gone" });
    await expect(h.provider.deleteVolume("vol-z")).resolves.toBeUndefined();
    expect(h.lastRequest().method).toBe("DELETE");
    expect(h.lastRequest().url).toBe(`${API_BASE}/volumes/vol-z`);
  });
});

// ---------------------------------------------------------------------------
// waitForAction — poll loop, success, error (no throw), timeout
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider waitForAction", () => {
  test("returns immediately when the first poll is completed", async () => {
    const h = makeHarness();
    h.queueJson({ action: { id: 50, status: "completed", type: "create" } });
    const action = await h.provider.waitForAction(50);
    expect(action).toMatchObject({ id: 50, status: "success" }); // completed → success
    expect(h.lastRequest().url).toBe(`${API_BASE}/actions/50`);
    expect(h.recorded.length).toBe(1);
  });

  test("polls until the action leaves in-progress (loop runs more than once)", async () => {
    const h = makeHarness();
    h.queueJson({ action: { id: 51, status: "in-progress", type: "create" } });
    h.queueJson({ action: { id: 51, status: "completed", type: "create" } });
    const action = await h.provider.waitForAction(51);
    expect(action.status).toBe("success");
    // One in-progress poll + one terminal poll.
    expect(h.recorded.length).toBe(2);
  });

  test("returns an errored action WITHOUT throwing", async () => {
    const h = makeHarness();
    h.queueJson({ action: { id: 52, status: "errored", type: "create" } });
    const action = await h.provider.waitForAction(52);
    expect(action.status).toBe("error"); // errored → error
    expect(action.error).toMatchObject({ code: "errored" });
  });

  test("throws transport_error when the deadline is already past (no fetch)", async () => {
    const h = makeHarness();
    await expect(h.provider.waitForAction(53, 0)).rejects.toMatchObject({
      code: "transport_error",
    });
    expect(h.recorded.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Catalog (read-only)
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider catalog", () => {
  test("listServerTypes unwraps sizes and surfaces vcpus/memoryMb", async () => {
    const h = makeHarness();
    h.queueJson({
      sizes: [{ slug: "s-2vcpu-2gb", vcpus: 2, memory: 2048, disk: 50, available: true }],
    });
    const types = await h.provider.listServerTypes();
    expect(h.lastRequest().url).toBe(`${API_BASE}/sizes?per_page=200`);
    expect(types).toEqual([{ id: "s-2vcpu-2gb", name: "s-2vcpu-2gb", vcpus: 2, memoryMb: 2048 }]);
  });

  test("listLocations unwraps regions to {id: slug, name}", async () => {
    const h = makeHarness();
    h.queueJson({ regions: [{ slug: "nyc1", name: "New York 1", available: true }] });
    const locations = await h.provider.listLocations();
    expect(h.lastRequest().url).toBe(`${API_BASE}/regions?per_page=200`);
    expect(locations).toEqual([{ id: "nyc1", name: "New York 1" }]);
  });

  test("listImages encodes the type filter and ignores architecture", async () => {
    const h = makeHarness();
    h.queueJson({ images: [{ id: 555, name: "snap-a", slug: null, type: "snapshot" }] });
    const images = await h.provider.listImages({ type: "snapshot", architecture: "arm" });
    expect(h.lastRequest().url).toBe(`${API_BASE}/images?per_page=200&type=snapshot`);
    expect(images).toEqual([{ id: 555, name: "snap-a" }]);
  });

  test("listImages with no filter hits /images with only per_page", async () => {
    const h = makeHarness();
    h.queueJson({ images: [] });
    await h.provider.listImages();
    expect(h.lastRequest().url).toBe(`${API_BASE}/images?per_page=200`);
  });
});

// ---------------------------------------------------------------------------
// Error mapping — mapStatusToCode + quota priority
// ---------------------------------------------------------------------------

describe("DigitalOceanComputeProvider error mapping", () => {
  async function expectCode(status: number, body: unknown, code: string): Promise<void> {
    const h = makeHarness();
    h.queueStatus(status, body);
    let caught: unknown;
    try {
      // listServers is the simplest GET that surfaces request() errors.
      await h.provider.listServers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DigitalOceanComputeError);
    expect((caught as DigitalOceanComputeError).code).toBe(code as never);
    expect((caught as DigitalOceanComputeError).status).toBe(status);
  }

  test("422 limit_reached → quota_exceeded (wins over invalid_input fallback)", async () => {
    await expectCode(
      422,
      { id: "limit_reached", message: "droplet limit reached" },
      "quota_exceeded",
    );
  });

  test("422 too_many_requests_droplet_limit → quota_exceeded", async () => {
    await expectCode(
      422,
      { id: "too_many_requests_droplet_limit", message: "too many" },
      "quota_exceeded",
    );
  });

  test("404 → not_found", async () => {
    await expectCode(404, { id: "not_found", message: "gone" }, "not_found");
  });

  test("401 → missing_token", async () => {
    await expectCode(401, { id: "unauthorized", message: "no token" }, "missing_token");
  });

  test("403 → missing_token", async () => {
    await expectCode(403, { id: "forbidden", message: "nope" }, "missing_token");
  });

  test("422 (no quota id) → invalid_input", async () => {
    await expectCode(422, { id: "unprocessable_entity", message: "bad" }, "invalid_input");
  });

  test("400 → invalid_input", async () => {
    await expectCode(400, { id: "bad_request", message: "bad" }, "invalid_input");
  });

  test("429 → rate_limited", async () => {
    await expectCode(429, { id: "too_many_requests", message: "slow down" }, "rate_limited");
  });

  test("500 → server_error", async () => {
    await expectCode(500, { id: "server_error", message: "boom" }, "server_error");
  });

  test("a non-JSON error body maps to server_error (JSON parse fails before status mapping)", async () => {
    const h = makeHarness();
    // A genuine non-JSON body (HTML) on a non-2xx status. The provider tries to
    // JSON.parse it, fails, and throws server_error from the parse branch.
    h.queueRaw("<html>502 Bad Gateway</html>", 502);
    let caught: unknown;
    try {
      await h.provider.listServers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DigitalOceanComputeError);
    expect((caught as DigitalOceanComputeError).code).toBe("server_error");
    expect((caught as DigitalOceanComputeError).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Status mappers (pure)
// ---------------------------------------------------------------------------

describe("status mappers", () => {
  test("mapDropletStatus normalizes the DO vocabulary to Hetzner vocabulary", () => {
    expect(mapDropletStatus("active")).toBe("running");
    expect(mapDropletStatus("new")).toBe("initializing");
    expect(mapDropletStatus("off")).toBe("off");
    expect(mapDropletStatus("archive")).toBe("off");
    // Unknown passthrough.
    expect(mapDropletStatus("weird")).toBe("weird");
  });

  test("mapActionStatus normalizes the DO action vocabulary", () => {
    expect(mapActionStatus("completed")).toBe("success");
    expect(mapActionStatus("errored")).toBe("error");
    expect(mapActionStatus("in-progress")).toBe("running");
    expect(mapActionStatus("weird")).toBe("weird");
  });
});

// ---------------------------------------------------------------------------
// Provider selection — getComputeProvider() / isComputeConfigured()
//
// Behavioral coverage for the `compute-provider.ts` wiring: COMPUTE_PROVIDER
// selects DO vs Hetzner; isComputeConfigured() reports the SELECTED provider's
// token presence. Env is saved/restored per test (precedent: the Hetzner
// characterization test's env block).
// ---------------------------------------------------------------------------

describe("getComputeProvider / isComputeConfigured selection", () => {
  const ENV_KEYS = [
    "COMPUTE_PROVIDER",
    "DO_API_TOKEN",
    "DIGITALOCEAN_TOKEN",
    "HCLOUD_TOKEN",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("COMPUTE_PROVIDER=digitalocean returns a DigitalOceanComputeProvider", () => {
    process.env.COMPUTE_PROVIDER = "digitalocean";
    expect(getComputeProvider()).toBeInstanceOf(DigitalOceanComputeProvider);
  });

  test("default (unset) returns the Hetzner client", () => {
    // getHetznerCloudClient() requires a token to construct.
    process.env.HCLOUD_TOKEN = "hcloud-abc";
    expect(getComputeProvider()).toBeInstanceOf(HetznerCloudClient);
  });

  test("any non-digitalocean value falls back to Hetzner", () => {
    process.env.COMPUTE_PROVIDER = "aws";
    process.env.HCLOUD_TOKEN = "hcloud-abc";
    expect(getComputeProvider()).toBeInstanceOf(HetznerCloudClient);
  });

  test("isComputeConfigured tracks the DO token when provider=digitalocean", () => {
    process.env.COMPUTE_PROVIDER = "digitalocean";
    expect(isComputeConfigured()).toBe(false);
    process.env.DO_API_TOKEN = "do-token";
    expect(isComputeConfigured()).toBe(true);
  });

  test("isComputeConfigured also honors DIGITALOCEAN_TOKEN for the DO provider", () => {
    process.env.COMPUTE_PROVIDER = "digitalocean";
    process.env.DIGITALOCEAN_TOKEN = "do-token-alt";
    expect(isComputeConfigured()).toBe(true);
  });

  test("isComputeConfigured tracks the Hetzner token when provider defaults to hetzner", () => {
    expect(isComputeConfigured()).toBe(false);
    process.env.HCLOUD_TOKEN = "hcloud-abc";
    expect(isComputeConfigured()).toBe(true);
  });

  test("a DO token does NOT make the default (hetzner) provider configured", () => {
    // Cross-check: isComputeConfigured reports the SELECTED provider, not any token.
    process.env.DO_API_TOKEN = "do-token";
    expect(isComputeConfigured()).toBe(false);
  });
});
