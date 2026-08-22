/**
 * Exercises Hetzner lifecycle authority with a deterministic fetch harness.
 * The real client validates provider envelopes, deadline propagation, terminal
 * actions, and exact-resource readback without making external requests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HetznerCloudClient } from "./hetzner-cloud-api";

type ResponseFactory = (init: RequestInit | undefined) => Response | Promise<Response>;

const TOKEN = "lifecycle-test-token";
let originalFetch: typeof globalThis.fetch;
let responses: ResponseFactory[];
let requests: Array<{ method: string; path: string }>;

function json(body: unknown, status = 200): void {
  responses.push(() => Response.json(body, { status }));
}

function empty(status = 204): void {
  responses.push(() => new Response(null, { status }));
}

function action(
  id: number,
  command: string,
  status: "running" | "success" | "error",
  resource: { id: number; type: string },
) {
  return {
    id,
    command,
    status,
    progress: status === "success" ? 100 : 0,
    resources: [resource],
    error: status === "error" ? { code: "provider_failed", message: "failed" } : null,
  };
}

function server(id: number, status = "running") {
  return {
    id,
    name: `node-${id}`,
    status,
    public_net: { ipv4: null, ipv6: null, firewalls: [] },
  };
}

function volume(id: number, serverId: number | null = null) {
  return {
    id,
    name: `volume-${id}`,
    status: "available",
    server: serverId,
    linux_device: serverId === null ? null : `/dev/disk/by-id/scsi-0HC_Volume_${id}`,
  };
}

function client(options: { requestTimeoutMs?: number; lifecycleTimeoutMs?: number } = {}) {
  return HetznerCloudClient.withToken(TOKEN, options);
}

function createServerInput() {
  return {
    name: "node-41",
    serverType: "cax21",
    location: "fsn1",
    image: "ubuntu-24.04",
    userData: "#cloud-config\n",
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  responses = [];
  requests = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    requests.push({ method: init?.method ?? "GET", path: url.pathname });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
    return next(init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Hetzner lifecycle envelopes", () => {
  test("rejects incomplete create acceptance before polling or readback", async () => {
    json({ server: server(41), root_password: null, next_actions: [] }, 201);

    await expect(client().createServer(createServerInput())).rejects.toMatchObject({
      code: "server_error",
    });
    expect(requests).toHaveLength(1);
  });

  test("awaits every returned action and returns only exact running readback", async () => {
    json(
      {
        server: server(41, "initializing"),
        action: action(1, "create_server", "running", { id: 41, type: "server" }),
        next_actions: [action(2, "attach_network", "running", { id: 900, type: "network" })],
        root_password: null,
      },
      201,
    );
    json({ action: action(1, "create_server", "success", { id: 41, type: "server" }) });
    json({ action: action(2, "attach_network", "success", { id: 900, type: "network" }) });
    json({ server: server(41) });

    await expect(client().createServer(createServerInput())).resolves.toMatchObject({
      server: { id: 41, status: "running" },
    });
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/servers",
      "/v1/actions/1",
      "/v1/actions/2",
      "/v1/servers/41",
    ]);
  });

  test("rejects terminal action errors and mismatched action IDs without readback", async () => {
    json(
      {
        server: server(41, "initializing"),
        action: action(3, "create_server", "running", { id: 41, type: "server" }),
        next_actions: [],
        root_password: null,
      },
      201,
    );
    json({ action: action(4, "create_server", "success", { id: 41, type: "server" }) });

    await expect(client().createServer(createServerInput())).rejects.toMatchObject({
      code: "server_error",
    });
    expect(requests.map(({ path }) => path)).toEqual(["/v1/servers", "/v1/actions/3"]);

    responses = [];
    requests = [];
    json({ action: action(5, "delete_server", "error", { id: 41, type: "server" }) });
    await expect(client().waitForAction(5)).rejects.toMatchObject({ code: "server_error" });
  });

  test("rejects mismatched by-id server and volume readbacks", async () => {
    json({ server: server(42) });
    await expect(client().getServer(41)).rejects.toMatchObject({ code: "server_error" });

    json({ volume: volume(52) });
    await expect(client().getVolume(51)).rejects.toMatchObject({ code: "server_error" });
  });
});

describe("Hetzner lifecycle deadlines and absence", () => {
  test("keeps the request timer active while the response body is read", async () => {
    responses.push((init) => {
      const signal = init?.signal;
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("body read aborted")), {
              once: true,
            });
          }),
      } as Response;
    });

    await expect(client({ requestTimeoutMs: 10 }).listServers()).rejects.toMatchObject({
      code: "transport_error",
    });
  });

  test("shares one deadline across every returned action instead of resetting per poll", async () => {
    json(
      {
        server: server(41, "initializing"),
        action: action(11, "create_server", "running", { id: 41, type: "server" }),
        next_actions: [action(12, "attach_network", "running", { id: 900, type: "network" })],
        root_password: null,
      },
      201,
    );
    responses.push(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                Response.json({
                  action: action(11, "create_server", "success", {
                    id: 41,
                    type: "server",
                  }),
                }),
              ),
            20,
          );
        }),
    );
    responses.push((init) => {
      const signal = init?.signal;
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("deadline reached")), {
              once: true,
            });
          }),
      } as Response;
    });

    const startedAt = Date.now();
    await expect(
      client({ requestTimeoutMs: 1_000, lifecycleTimeoutMs: 100 }).createServer(
        createServerInput(),
      ),
    ).rejects.toMatchObject({ code: "transport_error" });
    expect(Date.now() - startedAt).toBeLessThan(350);
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/servers",
      "/v1/actions/11",
      "/v1/actions/12",
    ]);
  });

  test("does not treat action-poll 404 as target absence", async () => {
    json({
      action: action(8, "delete_server", "running", { id: 41, type: "server" }),
    });
    json({ error: { code: "not_found", message: "action missing" } }, 404);

    await expect(client().deleteServer(41)).rejects.toMatchObject({ code: "not_found" });
    expect(requests.map(({ path }) => path)).toEqual(["/v1/servers/41", "/v1/actions/8"]);
  });

  test("server deletion settles every returned action before absence readback", async () => {
    json({
      action: action(31, "delete_server", "success", {
        id: 41,
        type: "server",
      }),
      next_actions: [
        action(32, "detach_network", "running", {
          id: 900,
          type: "network",
        }),
      ],
    });
    json({
      action: action(32, "detach_network", "success", {
        id: 900,
        type: "network",
      }),
    });
    json({ error: { code: "not_found", message: "server missing" } }, 404);

    await expect(client().deleteServer(41)).resolves.toBeUndefined();
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/servers/41",
      "/v1/actions/32",
      "/v1/servers/41",
    ]);
  });

  test("accepts only exact target 404 as idempotent server deletion", async () => {
    json({ error: { code: "not_found", message: "server missing" } }, 404);
    await expect(client().deleteServer(41)).resolves.toBeUndefined();
    expect(requests).toEqual([{ method: "DELETE", path: "/v1/servers/41" }]);
  });

  test("volume delete requires exact post-delete absence", async () => {
    empty();
    json({ volume: volume(51) });
    await expect(client().deleteVolume(51)).rejects.toMatchObject({ code: "server_error" });

    responses = [];
    requests = [];
    empty();
    json({ error: { code: "not_found", message: "volume missing" } }, 404);
    await expect(client().deleteVolume(51)).resolves.toBeUndefined();
  });

  test("volume delete accepts 204 or settles a complete JSON lifecycle envelope", async () => {
    json({
      action: action(41, "delete_volume", "running", {
        id: 51,
        type: "volume",
      }),
      next_actions: [
        action(42, "detach_volume", "running", {
          id: 51,
          type: "volume",
        }),
      ],
    });
    json({
      action: action(41, "delete_volume", "success", {
        id: 51,
        type: "volume",
      }),
    });
    json({
      action: action(42, "detach_volume", "success", {
        id: 51,
        type: "volume",
      }),
    });
    json({ error: { code: "not_found", message: "volume missing" } }, 404);

    await expect(client().deleteVolume(51)).resolves.toBeUndefined();
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/volumes/51",
      "/v1/actions/41",
      "/v1/actions/42",
      "/v1/volumes/51",
    ]);

    responses = [];
    requests = [];
    json({ next_actions: [] });
    await expect(client().deleteVolume(51)).rejects.toMatchObject({
      code: "server_error",
    });
    expect(requests).toEqual([{ method: "DELETE", path: "/v1/volumes/51" }]);
  });

  test("create-volume readback proves attachment and device state", async () => {
    json({
      volume: volume(51, 41),
      action: action(9, "create_volume", "success", { id: 51, type: "volume" }),
      next_actions: [],
    });
    json({ volume: volume(51, 99) });

    await expect(
      client().createVolume({
        name: "volume-51",
        sizeGb: 10,
        location: "fsn1",
        serverId: 41,
      }),
    ).rejects.toMatchObject({ code: "server_error" });
  });
});
