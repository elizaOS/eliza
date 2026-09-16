// Exercises headscale client behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREAUTH_TTL_MIN,
  ECMA_TIME_CLIP_MS,
  HeadscaleClient,
  HeadscaleHttpError,
  MAX_PREAUTH_TTL_MIN,
  resolvePreAuthExpirationIso,
  resolvePreAuthTtlMs,
} from "./headscale-client";

const originalFetch = globalThis.fetch;

/**
 * The headscale pre-auth key TTL gates the provisioning-E2E reachable path: the
 * key must outlive container boot + VPN enrollment. A 10-min hardcoded window
 * was too tight on slow boots — the key expired mid-registration and the
 * container looped on re-auth (one prod agent hit 176 restarts). The box was
 * bumped via HEADSCALE_PREAUTH_TTL_MIN, but the source still hardcoded a short
 * window, so a daemon redeploy would regress it. This locks the durable repo
 * behavior: a 24h default + the env override that survives a redeploy.
 *
 * The default was raised 60m -> 1440m (24h) after the prod-2 hard-reset outage:
 * the baked key is the ONLY credential a de-authorized node can present after a
 * reboot, and a 60-min key is expired the moment such a reboot happens. 24h
 * widens the window a freshly provisioned agent can survive a delayed/early
 * reboot (the durable reconnect-first + re-key fix lives in the entrypoint).
 */
describe("resolvePreAuthTtlMs (headscale pre-auth key TTL)", () => {
  const original = process.env.HEADSCALE_PREAUTH_TTL_MIN;
  afterEach(() => {
    if (original === undefined) delete process.env.HEADSCALE_PREAUTH_TTL_MIN;
    else process.env.HEADSCALE_PREAUTH_TTL_MIN = original;
  });

  it("defaults to 24h (raised from 60m so a reboot key isn't already expired)", () => {
    delete process.env.HEADSCALE_PREAUTH_TTL_MIN;
    expect(DEFAULT_PREAUTH_TTL_MIN).toBe(1440);
    expect(resolvePreAuthTtlMs()).toBe(1440 * 60 * 1000);
  });

  it("honors HEADSCALE_PREAUTH_TTL_MIN so the box override survives a redeploy", () => {
    process.env.HEADSCALE_PREAUTH_TTL_MIN = "90";
    expect(resolvePreAuthTtlMs()).toBe(90 * 60 * 1000);
  });

  it("falls back to the 24h default for non-positive / non-numeric values", () => {
    for (const bad of ["0", "-5", "abc", "", "  "]) {
      process.env.HEADSCALE_PREAUTH_TTL_MIN = bad;
      expect(resolvePreAuthTtlMs()).toBe(DEFAULT_PREAUTH_TTL_MIN * 60 * 1000);
    }
  });

  it("rejects exponent, hex, fractional, subnormal, and prefix-garbage forms", () => {
    for (const bad of [
      "1e3",
      "1e10",
      "1e20",
      "0x10",
      "1.5",
      "5e-324",
      "90abc",
      "007",
      "144000000000",
    ]) {
      process.env.HEADSCALE_PREAUTH_TTL_MIN = bad;
      expect(resolvePreAuthTtlMs()).toBe(DEFAULT_PREAUTH_TTL_MIN * 60 * 1000);
    }
  });

  it("rejects leading or trailing whitespace instead of trimming it", () => {
    for (const bad of [" 90", "90 ", " 90 ", "\t90", "90\n", "90\r\n"]) {
      process.env.HEADSCALE_PREAUTH_TTL_MIN = bad;
      expect(resolvePreAuthTtlMs()).toBe(DEFAULT_PREAUTH_TTL_MIN * 60 * 1000);
    }
  });

  it("honors the operational max and rejects one minute past it", () => {
    process.env.HEADSCALE_PREAUTH_TTL_MIN = String(MAX_PREAUTH_TTL_MIN);
    expect(resolvePreAuthTtlMs()).toBe(MAX_PREAUTH_TTL_MIN * 60 * 1000);
    process.env.HEADSCALE_PREAUTH_TTL_MIN = String(MAX_PREAUTH_TTL_MIN + 1);
    expect(resolvePreAuthTtlMs()).toBe(DEFAULT_PREAUTH_TTL_MIN * 60 * 1000);
  });

  it("keeps Date.now() + ttl inside TimeClip", () => {
    process.env.HEADSCALE_PREAUTH_TTL_MIN = "90";
    const iso = resolvePreAuthExpirationIso();
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
  });
});

describe("HeadscaleClient upstream errors", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("preserves unreadable Headscale error bodies as the thrown cause", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => {
          throw new Error("body stream failed");
        },
        headers: new Headers(),
      } as Response;
    }) as typeof fetch;

    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });

    await expect(client.createPreAuthKey()).rejects.toMatchObject({
      message:
        "Headscale API POST /api/v1/preauthkey failed: 502 Bad Gateway; error body could not be read",
      cause: expect.objectContaining({ message: "body stream failed" }),
    });
  });

  it("sends a TimeClip-safe ISO expiration from the env TTL", async () => {
    const originalTtl = process.env.HEADSCALE_PREAUTH_TTL_MIN;
    process.env.HEADSCALE_PREAUTH_TTL_MIN = "90";
    const bodies: Array<{ expiration?: string }> = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      if (init?.body) {
        bodies.push(JSON.parse(String(init.body)) as { expiration?: string });
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          preAuthKey: { key: "hskey", expiration: "unused" },
        }),
        text: async () => "{}",
        headers: new Headers({ "content-type": "application/json" }),
      } as Response;
    }) as typeof fetch;
    try {
      const before = Date.now();
      const client = new HeadscaleClient({
        apiUrl: "https://headscale.example",
        apiKey: "secret",
        user: "1",
      });
      await client.createPreAuthKey();
      const after = Date.now();
      expect(bodies).toHaveLength(1);
      const expiration = Date.parse(bodies[0]?.expiration ?? "");
      expect(Number.isFinite(expiration)).toBe(true);
      expect(expiration).toBeGreaterThanOrEqual(before + 90 * 60 * 1000 - 5_000);
      expect(expiration).toBeLessThanOrEqual(after + 90 * 60 * 1000 + 5_000);
    } finally {
      if (originalTtl === undefined) delete process.env.HEADSCALE_PREAUTH_TTL_MIN;
      else process.env.HEADSCALE_PREAUTH_TTL_MIN = originalTtl;
    }
  });

  it("does not fetch when even the fallback expiration is above TimeClip", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(Date, "now").mockReturnValue(ECMA_TIME_CLIP_MS - 1000);
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });
    await expect(client.createPreAuthKey()).rejects.toThrow(/TimeClip/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when even the fallback expiration is below TimeClip", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(Date, "now").mockReturnValue(
      -ECMA_TIME_CLIP_MS - DEFAULT_PREAUTH_TTL_MIN * 60 * 1000 - 1,
    );
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });
    await expect(client.createPreAuthKey()).rejects.toThrow(/TimeClip/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HeadscaleClient v0.28 pre-auth identity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits user ownership for a tagged key", async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        ...(typeof init?.body === "string"
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      });
      return Response.json({ preAuthKey: { key: "hskey-tagged" } });
    }) as typeof fetch;

    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "org-must-not-own-tagged-key",
    });
    await client.createPreAuthKey({
      aclTags: ["tag:agent"],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://headscale.example/api/v1/preauthkey");
    expect(requests[0]?.body).not.toHaveProperty("user");
    expect(requests[0]?.body?.aclTags).toEqual(["tag:agent"]);
  });

  it("rejects mixed tag and user ownership before network access", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "17",
    });

    await expect(
      client.createPreAuthKey({
        aclTags: ["tag:agent"],
        user: "org-invalid-owner",
        ensureUser: true,
      }),
    ).rejects.toThrow(/cannot also carry user ownership/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains a numeric user for an untagged personal key", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      if (typeof init?.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Response.json({ preAuthKey: { key: "hskey-personal" } });
    }) as typeof fetch;

    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "17",
    });
    await client.createPreAuthKey({ aclTags: [] });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.user).toBe(17);
    expect(bodies[0]?.aclTags).toEqual([]);
  });
});

describe("HeadscaleClient v0.28 pre-auth cleanup contract", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("expires by JSON id and deletes by query id", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });
    await client.expirePreAuthKey("123");
    await client.deletePreAuthKey("123");
    expect(requests).toEqual([
      {
        url: "https://headscale.example/api/v1/preauthkey/expire",
        method: "POST",
        body: JSON.stringify({ id: "123" }),
      },
      {
        url: "https://headscale.example/api/v1/preauthkey?id=123",
        method: "DELETE",
      },
    ]);
  });

  it("rejects non-numeric ids before sending a bearer", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });
    await expect(client.expirePreAuthKey("key-secret")).rejects.toThrow(/invalid pre-auth key id/);
    await expect(client.deletePreAuthKey("0")).rejects.toThrow(/invalid pre-auth key id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses only an actual HTTP 404 during idempotent cleanup", async () => {
    const statuses = [404, 404, 404];
    globalThis.fetch = vi.fn(
      async () =>
        new Response("missing", {
          status: statuses.shift() ?? 500,
          statusText: "Not Found",
        }),
    ) as typeof fetch;
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });

    await expect(client.deleteNode("9")).resolves.toBeUndefined();
    await expect(client.expirePreAuthKey("123")).resolves.toBeUndefined();
    await expect(client.deletePreAuthKey("123")).resolves.toBeUndefined();
  });

  it("does not suppress a non-404 failure merely because its text contains 404", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("failure", {
          status: 500,
          statusText: "upstream incident 404",
        }),
    ) as typeof fetch;
    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });

    await expect(client.deletePreAuthKey("123")).rejects.toMatchObject({
      name: "HeadscaleHttpError",
      status: 500,
      method: "DELETE",
      path: "/api/v1/preauthkey?id=123",
    } satisfies Partial<HeadscaleHttpError>);
  });
});

/**
 * Blue/green upgrade regression: when the preserved green node still holds the
 * base hostname, Headscale renames the freshly registered blue node to
 * `<name>-<8 lowercase alphanumerics>` (observed: eliza-00e6292c-e55-cnpx9uop).
 * An exact-name poll never finds it and the upgrade times out despite a healthy
 * registration. getNodeByNameOrSuffixed tolerates the collision rename: exact
 * match wins; otherwise the newest node matching the exact rename shape, gated
 * on createdAfter (renamed nodes keep their suffix forever, so old suffixed
 * nodes must never be adopted), optionally excluding a known node id (the
 * preserved green node).
 */
describe("getNodeByNameOrSuffixed (Headscale collision-rename tolerance)", () => {
  const makeNode = (id: string, name: string, createdAt?: string): Record<string, unknown> => ({
    id,
    name,
    user: { name: "1" },
    ipAddresses: ["100.64.0.1"],
    online: true,
    lastSeen: new Date().toISOString(),
    createdAt: createdAt ?? new Date().toISOString(),
  });

  const mockNodes = (nodes: Record<string, unknown>[]) => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ nodes }),
        text: async () => JSON.stringify({ nodes }),
        headers: new Headers({ "content-type": "application/json" }),
      } as Response;
    }) as typeof fetch;
  };

  const client = () =>
    new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("prefers the exact hostname match over suffixed candidates", async () => {
    mockNodes([
      makeNode("7", "eliza-abc123-k9x2m4p1"),
      makeNode("3", "eliza-abc123"),
      makeNode("9", "eliza-abc123-m4p1q7w2"),
    ]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123");
    expect(node?.id).toBe("3");
    expect(node?.name).toBe("eliza-abc123");
  });

  it("finds the collision-renamed suffixed node when no exact match exists", async () => {
    mockNodes([makeNode("2", "eliza-other"), makeNode("5", "eliza-abc123-k9x2m4p1")]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123");
    expect(node?.id).toBe("5");
    expect(node?.name).toBe("eliza-abc123-k9x2m4p1");
  });

  it("strict cleanup lookup returns the actual collision-suffixed node", async () => {
    const createdAfter = new Date("2026-08-22T12:00:00.000Z");
    mockNodes([
      makeNode("4", "eliza-abc123-old1old1", "2026-08-22T11:59:59.000Z"),
      makeNode("10", "eliza-abc123-new7new7", "2026-08-22T12:00:01.000Z"),
    ]);
    const node = await client().getNodeByNameOrSuffixedStrict("eliza-abc123", {
      createdAfter,
    });
    expect(node).toMatchObject({ id: "10", name: "eliza-abc123-new7new7" });
  });

  it("strict cleanup lookup propagates Headscale listing failure", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    ) as typeof fetch;
    await expect(client().getNodeByNameOrSuffixedStrict("eliza-abc123")).rejects.toMatchObject({
      status: 503,
      method: "GET",
      path: "/api/v1/node",
    });
  });

  it("matches the rename shape observed in production", async () => {
    mockNodes([makeNode("11", "eliza-00e6292c-e55-cnpx9uop")]);
    const node = await client().getNodeByNameOrSuffixed("eliza-00e6292c-e55");
    expect(node?.id).toBe("11");
  });

  it("respects excludeNodeId so the preserved green node is never returned", async () => {
    mockNodes([
      makeNode("3", "eliza-abc123"), // preserved green node holding the base name
      makeNode("8", "eliza-abc123-k9x2m4p1"), // fresh blue registration
    ]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123", {
      excludeNodeId: "3",
    });
    expect(node?.id).toBe("8");
    expect(node?.name).toBe("eliza-abc123-k9x2m4p1");
  });

  it("picks the newest suffixed registration when several exist", async () => {
    mockNodes([
      makeNode("4", "eliza-abc123-old1old1"),
      makeNode("9", "eliza-abc123-new7new7"),
      makeNode("6", "eliza-abc123-mid3mid3"),
    ]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123");
    expect(node?.id).toBe("9");
  });

  it("orders candidate ids numerically, not lexicographically", async () => {
    // Headscale ids are numeric strings; string compare ranks "9" > "10".
    mockNodes([makeNode("9", "eliza-abc123-old1old1"), makeNode("10", "eliza-abc123-new7new7")]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123");
    expect(node?.id).toBe("10");
  });

  it("returns null when nothing matches the base name or its suffixes", async () => {
    mockNodes([makeNode("1", "eliza-zzz"), makeNode("2", "elizaabc123")]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123");
    expect(node).toBeNull();
  });

  it("does not treat a different agent sharing the prefix without hyphen as a match", async () => {
    mockNodes([makeNode("1", "eliza-abc1234")]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123");
    expect(node).toBeNull();
  });

  it("rejects suffixes that are not exactly 8 lowercase alphanumerics", async () => {
    // A sibling agent's hostname is `<name>-<12-char uuid prefix>` with a
    // hyphen at index 8 — it shares the `<name>-` prefix but is NOT a
    // collision rename of `name` and must never be adopted as one.
    mockNodes([
      makeNode("1", "eliza-00e6292c-e55"), // sibling: 12-char uuid prefix, hyphen at index 8
      makeNode("2", "eliza-abcdefg"), // 7 chars: too short
      makeNode("3", "eliza-abcdefghi"), // 9 chars: too long
      makeNode("4", "eliza-abcd-efgh"), // hyphen inside the suffix
      makeNode("5", "eliza-ABCDEFGH"), // uppercase: not DNS-safe rename output
    ]);
    const node = await client().getNodeByNameOrSuffixed("eliza");
    expect(node).toBeNull();
  });

  it("ignores suffixed nodes created before createdAfter (stale green/orphan)", async () => {
    // The previous cycle's green node and orphans from failed upgrades keep
    // their suffixed names forever; only a rename minted during THIS provision
    // may be adopted.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockNodes([makeNode("6", "eliza-abc123-k9x2m4p1", past)]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123", {
      createdAfter: new Date(),
    });
    expect(node).toBeNull();
  });

  it("adopts a suffixed node created at/after createdAfter", async () => {
    const pollStart = new Date(Date.now() - 5_000);
    mockNodes([
      makeNode("6", "eliza-abc123-old1old1", new Date(Date.now() - 60 * 60 * 1000).toISOString()),
      makeNode("7", "eliza-abc123-k9x2m4p1", new Date().toISOString()),
    ]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123", {
      createdAfter: pollStart,
    });
    expect(node?.id).toBe("7");
  });

  it("keeps exact-name matches exempt from the createdAfter gate", async () => {
    // The exact hostname is only ever held by the node this poll is waiting
    // for (or the excluded green node) — createdAt gating applies to suffixed
    // candidates only.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockNodes([makeNode("3", "eliza-abc123", past)]);
    const node = await client().getNodeByNameOrSuffixed("eliza-abc123", {
      createdAfter: new Date(),
    });
    expect(node?.id).toBe("3");
  });
});
