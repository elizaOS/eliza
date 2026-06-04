/**
 * Characterization test for `HetznerCloudClient` (the IaaS transport layer).
 *
 * Purpose: pin the *current, observable* public surface and behavior of
 * `hetzner-cloud-api.ts` so the upcoming `ComputeProvider`-seam extraction
 * (Hetzner refactored to implement a shared interface) can be proven
 * behavior-preserving. This is a golden/record test of the unchanged code —
 * it must PASS as-is and FAIL if the refactor silently changes a request
 * shape, a response mapping, or the error-code mapping.
 *
 * No network: the only external dependency is the global `fetch`, which is
 * called directly from the private `request()` method. We replace
 * `globalThis.fetch` with a recording stub that returns real `Response`
 * objects, so `.ok` / `.status` / `.text()` semantics match production
 * exactly, and assert against the recorded requests + the mapped results.
 *
 * Gotchas pinned by construction (see also the inline notes):
 *  - `HCLOUD_API_BASE` is a module-load constant → we assert against the
 *    default `https://api.hetzner.cloud/v1` host (overriding the env var
 *    after import does nothing).
 *  - JSON parse happens BEFORE status→code mapping, so every error fixture
 *    body is valid JSON.
 *  - `waitForAction` real-sleeps 1500ms between polls, so success fixtures
 *    resolve on the FIRST poll.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type CreateServerInput,
  type CreateVolumeInput,
  getHetznerCloudClient,
  HetznerCloudClient,
  HetznerCloudError,
  isHetznerCloudConfigured,
} from "./hetzner-cloud-api";

const API_BASE = "https://api.hetzner.cloud/v1";
const TOKEN = "test-token-abc";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Queue-driven `fetch` stub: each call shifts the next queued Response. */
let recorded: RecordedRequest[] = [];
let responseQueue: Array<() => Response | Promise<Response>> = [];
let originalFetch: typeof globalThis.fetch;

function queueJson(body: unknown, status = 200): void {
  responseQueue.push(() => new Response(JSON.stringify(body), { status }));
}

function queueStatus(status: number, body?: unknown): void {
  responseQueue.push(
    () => new Response(body === undefined ? "" : JSON.stringify(body), { status }),
  );
}

function lastRequest(): RecordedRequest {
  const req = recorded.at(-1);
  if (!req) throw new Error("no request was recorded");
  return req;
}

beforeEach(() => {
  recorded = [];
  responseQueue = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): HetznerCloudClient {
  return HetznerCloudClient.withToken(TOKEN);
}

// ---------------------------------------------------------------------------
// Public surface — method names exist (catches a rename during extraction)
// ---------------------------------------------------------------------------

describe("HetznerCloudClient public surface", () => {
  test("pins the set of public methods", () => {
    const c = client();
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
      expect(typeof (c as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });

  test("static constructors and module accessors exist", () => {
    expect(typeof HetznerCloudClient.fromEnv).toBe("function");
    expect(typeof HetznerCloudClient.withToken).toBe("function");
    expect(typeof getHetznerCloudClient).toBe("function");
    expect(typeof isHetznerCloudConfigured).toBe("function");
  });

  test("withToken rejects an empty token with missing_token", () => {
    expect(() => HetznerCloudClient.withToken("")).toThrow(HetznerCloudError);
    try {
      HetznerCloudClient.withToken("");
    } catch (err) {
      expect((err as HetznerCloudError).code).toBe("missing_token");
    }
  });
});

// ---------------------------------------------------------------------------
// Transport invariants — auth header + base URL on every call
// ---------------------------------------------------------------------------

describe("HetznerCloudClient transport", () => {
  test("sends Bearer auth + JSON content-type to the default API base", async () => {
    queueJson({ servers: [] });
    await client().listServers();

    const req = lastRequest();
    expect(req.url).toBe(`${API_BASE}/servers`);
    expect(req.method).toBe("GET");
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["Content-Type"]).toBe("application/json");
  });

  test("a 204 No Content response maps to undefined (delete path)", async () => {
    queueStatus(204);
    const result = await client().deleteServer(7);
    expect(result).toBeUndefined();
    expect(lastRequest().method).toBe("DELETE");
    expect(lastRequest().url).toBe(`${API_BASE}/servers/7`);
  });

  test("a transport-level fetch rejection maps to transport_error", async () => {
    responseQueue.push(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(client().listServers()).rejects.toMatchObject({
      code: "transport_error",
    });
  });
});

// ---------------------------------------------------------------------------
// Servers — request construction + response mapping
// ---------------------------------------------------------------------------

describe("HetznerCloudClient servers", () => {
  test("listServers without labels hits /servers with no query string", async () => {
    queueJson({ servers: [{ id: 1 }] });
    const servers = await client().listServers();
    expect(servers).toEqual([{ id: 1 }] as never);
    expect(lastRequest().url).toBe(`${API_BASE}/servers`);
  });

  test("listServers encodes a label selector", async () => {
    queueJson({ servers: [] });
    await client().listServers({ "managed-by": "eliza-cloud" });
    expect(lastRequest().url).toBe(`${API_BASE}/servers?label_selector=managed-by=eliza-cloud`);
  });

  test("getServer returns the server payload on 200", async () => {
    queueJson({ server: { id: 42, name: "node-a" } });
    const server = await client().getServer(42);
    expect(server).toMatchObject({ id: 42, name: "node-a" });
    expect(lastRequest().url).toBe(`${API_BASE}/servers/42`);
  });

  test("getServer returns null on 404 (does not throw)", async () => {
    queueStatus(404, { error: { code: "not_found", message: "no such server" } });
    const server = await client().getServer(999);
    expect(server).toBeNull();
  });

  test("createServer remaps camelCase input to the Hetzner wire body", async () => {
    queueJson({ server: { id: 100, name: "n1" }, root_password: "pw" });
    const input: CreateServerInput = {
      name: "n1",
      serverType: "cax21",
      location: "fsn1",
      image: "ubuntu-24.04",
      userData: "#cloud-config\n",
      sshKeyIds: [11, 22],
      networkIds: [33],
      labels: { purpose: "test" },
    };
    const result = await client().createServer(input);

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API_BASE}/servers`);
    expect(req.body).toEqual({
      name: "n1",
      server_type: "cax21",
      location: "fsn1",
      image: "ubuntu-24.04",
      user_data: "#cloud-config\n",
      start_after_create: true,
      ssh_keys: [11, 22],
      networks: [33],
      labels: { purpose: "test" },
    });
    // Response mapping: root_password → rootPassword.
    expect(result).toEqual({
      server: { id: 100, name: "n1" } as never,
      rootPassword: "pw",
    });
  });

  test("createServer omits ssh_keys/networks/labels when empty", async () => {
    queueJson({ server: { id: 101 }, root_password: null });
    await client().createServer({
      name: "n2",
      serverType: "cax21",
      location: "fsn1",
      image: "ubuntu-24.04",
      userData: "x",
      sshKeyIds: [],
      networkIds: [],
      labels: {},
    });
    expect(lastRequest().body).toEqual({
      name: "n2",
      server_type: "cax21",
      location: "fsn1",
      image: "ubuntu-24.04",
      user_data: "x",
      start_after_create: true,
    });
  });

  test("createServer rejects userData >32KiB BEFORE any fetch", async () => {
    const big = "a".repeat(32 * 1024 + 1);
    await expect(
      client().createServer({
        name: "n3",
        serverType: "cax21",
        location: "fsn1",
        image: "ubuntu-24.04",
        userData: big,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(recorded.length).toBe(0);
  });

  test("powerOff / powerOn POST to the action endpoints and return the action", async () => {
    queueJson({ action: { id: 5, command: "stop_server", status: "running", progress: 0 } });
    const off = await client().powerOff(7);
    expect(lastRequest().method).toBe("POST");
    expect(lastRequest().url).toBe(`${API_BASE}/servers/7/actions/poweroff`);
    expect(off).toMatchObject({ id: 5, status: "running" });

    queueJson({ action: { id: 6, command: "start_server", status: "running", progress: 0 } });
    await client().powerOn(7);
    expect(lastRequest().url).toBe(`${API_BASE}/servers/7/actions/poweron`);
  });
});

// ---------------------------------------------------------------------------
// Volumes — request construction + client-side location filter
// ---------------------------------------------------------------------------

describe("HetznerCloudClient volumes", () => {
  test("createVolume remaps sizeGb→size and defaults format to ext4", async () => {
    queueJson({ volume: { id: 200, name: "v1" } });
    const input: CreateVolumeInput = {
      name: "v1",
      sizeGb: 50,
      location: "fsn1",
    };
    await client().createVolume(input);
    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API_BASE}/volumes`);
    expect(req.body).toEqual({
      name: "v1",
      size: 50,
      location: "fsn1",
      format: "ext4",
    });
  });

  test("createVolume includes server/automount=false/labels when set", async () => {
    queueJson({ volume: { id: 201 } });
    await client().createVolume({
      name: "v2",
      sizeGb: 10,
      location: "nbg1",
      format: "xfs",
      serverId: 77,
      automount: false,
      labels: { tier: "data" },
    });
    expect(lastRequest().body).toEqual({
      name: "v2",
      size: 10,
      location: "nbg1",
      format: "xfs",
      server: 77,
      automount: false,
      labels: { tier: "data" },
    });
  });

  test("attachVolume body is {server, automount} and defaults automount=false", async () => {
    queueJson({ action: { id: 9, command: "attach_volume", status: "running", progress: 0 } });
    await client().attachVolume(200, 77);
    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API_BASE}/volumes/200/actions/attach`);
    expect(req.body).toEqual({ server: 77, automount: false });
  });

  test("detachVolume POSTs to the detach action endpoint", async () => {
    queueJson({ action: { id: 10, command: "detach_volume", status: "running", progress: 0 } });
    await client().detachVolume(200);
    expect(lastRequest().url).toBe(`${API_BASE}/volumes/200/actions/detach`);
    expect(lastRequest().method).toBe("POST");
  });

  test("deleteVolume issues a DELETE and resolves undefined on 204", async () => {
    queueStatus(204);
    const result = await client().deleteVolume(200);
    expect(result).toBeUndefined();
    expect(lastRequest().method).toBe("DELETE");
    expect(lastRequest().url).toBe(`${API_BASE}/volumes/200`);
  });

  test("getVolume returns null on 404", async () => {
    queueStatus(404, { error: { code: "not_found", message: "gone" } });
    expect(await client().getVolume(123)).toBeNull();
  });

  test("listVolumes applies the location filter CLIENT-SIDE after the fetch", async () => {
    queueJson({
      volumes: [
        { id: 1, location: { name: "fsn1" } },
        { id: 2, location: { name: "nbg1" } },
      ],
    });
    const result = await client().listVolumes({ location: "fsn1" });
    // The request itself carries no location query param (label only).
    expect(lastRequest().url).toBe(`${API_BASE}/volumes`);
    expect(result.map((v) => v.id)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// waitForAction — completes on first poll (no real sleep exercised)
// ---------------------------------------------------------------------------

describe("HetznerCloudClient waitForAction", () => {
  test("returns immediately when the first poll reports success", async () => {
    queueJson({ action: { id: 50, command: "create_server", status: "success", progress: 100 } });
    const action = await client().waitForAction(50);
    expect(action).toMatchObject({ id: 50, status: "success" });
    expect(lastRequest().url).toBe(`${API_BASE}/actions/50`);
    expect(recorded.length).toBe(1);
  });

  test("returns an error action without throwing (status !== running)", async () => {
    queueJson({
      action: {
        id: 51,
        command: "create_server",
        status: "error",
        progress: 0,
        error: { code: "boom", message: "failed" },
      },
    });
    const action = await client().waitForAction(51);
    expect(action.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Catalog — read-only GET shapes
// ---------------------------------------------------------------------------

describe("HetznerCloudClient catalog", () => {
  test("listServerTypes / listLocations unwrap their envelopes", async () => {
    queueJson({ server_types: [{ id: 1, name: "cax21" }] });
    expect(await client().listServerTypes()).toEqual([{ id: 1, name: "cax21" }] as never);
    expect(lastRequest().url).toBe(`${API_BASE}/server_types`);

    queueJson({ locations: [{ id: 1, name: "fsn1" }] });
    expect(await client().listLocations()).toEqual([{ id: 1, name: "fsn1" }] as never);
    expect(lastRequest().url).toBe(`${API_BASE}/locations`);
  });

  test("listImages encodes type + architecture query params", async () => {
    queueJson({ images: [] });
    await client().listImages({ type: "snapshot", architecture: "arm" });
    expect(lastRequest().url).toBe(`${API_BASE}/images?type=snapshot&architecture=arm`);
  });

  test("listImages with no filter hits /images with no query string", async () => {
    queueJson({ images: [{ id: 1 }] });
    await client().listImages();
    expect(lastRequest().url).toBe(`${API_BASE}/images`);
  });
});

// ---------------------------------------------------------------------------
// Error mapping — the highest-value pin (mapStatusToCode + quota priority)
// ---------------------------------------------------------------------------

describe("HetznerCloudClient error mapping", () => {
  async function expectCode(status: number, body: unknown, code: string): Promise<void> {
    queueStatus(status, body);
    let caught: unknown;
    try {
      // listServers is the simplest GET that surfaces request() errors.
      await client().listServers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HetznerCloudError);
    expect((caught as HetznerCloudError).code).toBe(code as never);
    expect((caught as HetznerCloudError).status).toBe(status);
  }

  test("403 with apiCode limit_reached → quota_exceeded (wins over auth fallback)", async () => {
    await expectCode(
      403,
      { error: { code: "limit_reached", message: "server limit reached" } },
      "quota_exceeded",
    );
  });

  test("403 with apiCode resource_limit_exceeded → quota_exceeded", async () => {
    await expectCode(
      403,
      { error: { code: "resource_limit_exceeded", message: "too many" } },
      "quota_exceeded",
    );
  });

  test("plain 403 (no quota apiCode) → missing_token", async () => {
    await expectCode(403, { error: { code: "forbidden", message: "nope" } }, "missing_token");
  });

  test("401 → missing_token", async () => {
    await expectCode(
      401,
      { error: { code: "unauthorized", message: "no token" } },
      "missing_token",
    );
  });

  test("404 (on a non-get-by-id call) → not_found", async () => {
    await expectCode(404, { error: { code: "not_found", message: "gone" } }, "not_found");
  });

  test("422 → invalid_input", async () => {
    await expectCode(422, { error: { code: "invalid_input", message: "bad" } }, "invalid_input");
  });

  test("400 → invalid_input", async () => {
    await expectCode(400, { error: { code: "json_error", message: "bad json" } }, "invalid_input");
  });

  test("429 → rate_limited", async () => {
    await expectCode(
      429,
      { error: { code: "rate_limit_exceeded", message: "slow" } },
      "rate_limited",
    );
  });

  test("500 → server_error", async () => {
    await expectCode(500, { error: { code: "service_error", message: "boom" } }, "server_error");
  });

  test("a non-JSON error body maps to server_error (parse precedes status mapping)", async () => {
    responseQueue.push(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    let caught: unknown;
    try {
      await client().listServers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HetznerCloudError);
    expect((caught as HetznerCloudError).code).toBe("server_error");
    expect((caught as HetznerCloudError).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Env-driven construction — fromEnv / isHetznerCloudConfigured
// ---------------------------------------------------------------------------

describe("HetznerCloudClient env construction", () => {
  const ENV_KEYS = ["HCLOUD_TOKEN", "HETZNER_CLOUD_TOKEN", "HETZNER_CLOUD_API_KEY"] as const;
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

  test("isHetznerCloudConfigured is false with no token env", () => {
    expect(isHetznerCloudConfigured()).toBe(false);
  });

  test("isHetznerCloudConfigured is true once HCLOUD_TOKEN is set", () => {
    process.env.HCLOUD_TOKEN = "abc";
    expect(isHetznerCloudConfigured()).toBe(true);
  });

  test("fromEnv throws missing_token when no token env is present", () => {
    expect(() => HetznerCloudClient.fromEnv()).toThrow(HetznerCloudError);
    try {
      HetznerCloudClient.fromEnv();
    } catch (err) {
      expect((err as HetznerCloudError).code).toBe("missing_token");
    }
  });

  test("fromEnv constructs a client when HCLOUD_TOKEN is set and uses it as Bearer", async () => {
    process.env.HCLOUD_TOKEN = "env-token-xyz";
    const c = HetznerCloudClient.fromEnv();
    queueJson({ servers: [] });
    await c.listServers();
    expect(lastRequest().headers.Authorization).toBe("Bearer env-token-xyz");
  });
});
