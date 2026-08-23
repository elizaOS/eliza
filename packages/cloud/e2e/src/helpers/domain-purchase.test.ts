/**
 * Deterministic unit coverage of the domain-purchase e2e helpers: price
 * ceiling, cheapest-quote selection (empty, single, ties, missing prices),
 * JSONL ledger append, deploy/status polling, and status-only detach/delete.
 * Drives the real module through an injected AuthedFetch script and a
 * loopback HTTP server; no production behaviour is changed.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AuthedFetch,
  appendDomainLedger,
  assertPriceCeiling,
  buyDomain,
  type CheckDomainResponse,
  createApp,
  DEFAULT_LEDGER_PATH,
  DEFAULT_MAX_PRICE_CENTS,
  type DomainQuote,
  deleteApp,
  deployAppToReady,
  detachDomain,
  getBalanceUsd,
  newRunId,
  PriceCeilingExceededError,
  pollDomainActive,
  probeUrlServes,
  quoteCheapestAvailableDomain,
} from "./domain-purchase";

interface AuthedCall {
  method: string;
  path: string;
  body: unknown;
}

interface AuthedReply {
  status: number;
  json: unknown;
}

function scriptedAuthed(replies: AuthedReply[]): {
  client: AuthedFetch;
  calls: AuthedCall[];
} {
  const calls: AuthedCall[] = [];
  const client = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const reply = replies[calls.length - 1];
    if (reply === undefined) {
      throw new Error(`unexpected AuthedFetch call ${method} ${path}`);
    }
    return reply;
  }) as AuthedFetch;
  return { client, calls };
}

function checkOk(
  domain: string,
  available: boolean,
  totalUsdCents: number | null,
): AuthedReply {
  const json: CheckDomainResponse = {
    success: true,
    domain,
    available,
    price: totalUsdCents === null ? undefined : { totalUsdCents },
  };
  return { status: 200, json };
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("loopback server did not bind a port");
  }
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  const wrapped = { url: `http://127.0.0.1:${addr.port}/`, close };
  servers.push(wrapped);
  return wrapped;
}

describe("constants", () => {
  test("DEFAULT_MAX_PRICE_CENTS is 500", () => {
    expect(DEFAULT_MAX_PRICE_CENTS).toBe(500);
  });

  test("DEFAULT_LEDGER_PATH points at the committed JSONL ledger", () => {
    expect(
      DEFAULT_LEDGER_PATH.endsWith("/domain-purchase-ledger/ledger.jsonl"),
    ).toBe(true);
  });
});

describe("newRunId", () => {
  test("returns the current epoch ms encoded as base36", () => {
    const before = Date.now();
    const id = newRunId();
    const after = Date.now();
    const parsed = Number.parseInt(id, 36);
    expect(id).toMatch(/^[0-9a-z]+$/);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe("appendDomainLedger", () => {
  test("creates the parent directory and appends one JSON object per line", () => {
    const dir = mkdtempSync(join(tmpdir(), "domain-purchase-ledger-"));
    const ledgerPath = join(dir, "nested", "ledger.jsonl");
    try {
      const first = {
        runId: "run1",
        timestamp: "2026-01-01T00:00:00.000Z",
        mode: "mock-stub" as const,
        phase: "attempt" as const,
        baseUrl: "https://api.example.test",
        domain: "alpha.test",
      };
      const second = {
        ...first,
        runId: "run2",
        phase: "purchased" as const,
        domain: "beta.test",
      };
      appendDomainLedger(ledgerPath, first);
      appendDomainLedger(ledgerPath, second);
      const lines = readFileSync(ledgerPath, "utf8").split("\n");
      expect(lines[0]).toBe(JSON.stringify(first));
      expect(lines[1]).toBe(JSON.stringify(second));
      expect(lines[2]).toBe("");
      expect(lines).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PriceCeilingExceededError", () => {
  test("names itself and formats available vs unavailable quotes", () => {
    const allQuotes: DomainQuote[] = [
      { domain: "a.test", available: true, totalUsdCents: 900 },
      { domain: "b.test", available: false, totalUsdCents: null },
      { domain: "c.test", available: true, totalUsdCents: null },
    ];
    const err = new PriceCeilingExceededError("a.test", 900, 500, allQuotes);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PriceCeilingExceededError");
    expect(err.domain).toBe("a.test");
    expect(err.quotedTotalUsdCents).toBe(900);
    expect(err.maxPriceCents).toBe(500);
    expect(err.allQuotes).toBe(allQuotes);
    expect(err.message).toBe(
      "price ceiling exceeded: cheapest available domain a.test quotes 900¢ > ceiling 500¢ — refusing to buy. All quotes: a.test=900¢, b.test=unavailable, c.test=null¢",
    );
  });
});

describe("assertPriceCeiling", () => {
  const candidate = {
    domain: "cheap.test",
    totalUsdCents: 500,
    allQuotes: [{ domain: "cheap.test", available: true, totalUsdCents: 500 }],
  };

  test("does not throw when the quote equals the ceiling", () => {
    expect(() => assertPriceCeiling(candidate, 500)).not.toThrow();
  });

  test("does not throw when the quote is below the ceiling", () => {
    expect(() => assertPriceCeiling(candidate, 501)).not.toThrow();
  });

  test("throws PriceCeilingExceededError when the quote is above the ceiling", () => {
    expect(() => assertPriceCeiling(candidate, 499)).toThrow(
      PriceCeilingExceededError,
    );
    try {
      assertPriceCeiling(candidate, 499);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PriceCeilingExceededError);
      const ceiling = err as PriceCeilingExceededError;
      expect(ceiling.domain).toBe("cheap.test");
      expect(ceiling.quotedTotalUsdCents).toBe(500);
      expect(ceiling.maxPriceCents).toBe(499);
      expect(ceiling.allQuotes).toBe(candidate.allQuotes);
    }
  });
});

describe("quoteCheapestAvailableDomain", () => {
  test("throws on an empty TLD queue with no check calls", async () => {
    const { client, calls } = scriptedAuthed([]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "slug", []),
    ).rejects.toThrow(
      'no candidate domain is available (or priced) for slug "slug": []',
    );
    expect(calls).toEqual([]);
  });

  test("throws when every candidate is unavailable", async () => {
    const { client, calls } = scriptedAuthed([
      checkOk("slug.com", false, 100),
      checkOk("slug.net", false, 50),
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "slug", ["com", "net"]),
    ).rejects.toThrow(
      /no candidate domain is available \(or priced\) for slug "slug"/,
    );
    expect(calls.map((c) => c.body)).toEqual([
      { domain: "slug.com" },
      { domain: "slug.net" },
    ]);
  });

  test("treats available candidates without a numeric total as unpriced", async () => {
    const { client } = scriptedAuthed([
      checkOk("slug.com", true, null),
      {
        status: 200,
        json: {
          success: true,
          available: true,
          price: { totalUsdCents: "199" },
        },
      },
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "slug", ["com", "net"]),
    ).rejects.toThrow(/no candidate domain is available \(or priced\)/);
  });

  test("returns the sole available priced candidate", async () => {
    const { client, calls } = scriptedAuthed([
      checkOk("solo.org", false, 10),
      checkOk("solo.com", true, 250),
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-9", "solo", ["org", "com"]),
    ).resolves.toEqual({
      domain: "solo.com",
      totalUsdCents: 250,
      allQuotes: [
        { domain: "solo.org", available: false, totalUsdCents: 10 },
        { domain: "solo.com", available: true, totalUsdCents: 250 },
      ],
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/apps/app-9/domains/check",
        body: { domain: "solo.org" },
      },
      {
        method: "POST",
        path: "/api/v1/apps/app-9/domains/check",
        body: { domain: "solo.com" },
      },
    ]);
  });

  test("picks the lowest numeric total among mixed available candidates", async () => {
    const { client } = scriptedAuthed([
      checkOk("mix.com", true, 400),
      checkOk("mix.net", false, 1),
      checkOk("mix.org", true, 199),
      checkOk("mix.io", true, 1990),
    ]);
    const result = await quoteCheapestAvailableDomain(client, "app-1", "mix", [
      "com",
      "net",
      "org",
      "io",
    ]);
    expect(result.domain).toBe("mix.org");
    expect(result.totalUsdCents).toBe(199);
    expect(result.allQuotes).toHaveLength(4);
  });

  test("keeps TLD order on a price tie (stable sort)", async () => {
    const { client } = scriptedAuthed([
      checkOk("tie.net", true, 100),
      checkOk("tie.com", true, 100),
    ]);
    const result = await quoteCheapestAvailableDomain(client, "app-1", "tie", [
      "net",
      "com",
    ]);
    expect(result.domain).toBe("tie.net");
    expect(result.totalUsdCents).toBe(100);
  });

  test("treats a zero-cent available quote as cheaper than a positive one", async () => {
    const { client } = scriptedAuthed([
      checkOk("z.com", true, 50),
      checkOk("z.net", true, 0),
    ]);
    const result = await quoteCheapestAvailableDomain(client, "app-1", "z", [
      "com",
      "net",
    ]);
    expect(result).toMatchObject({ domain: "z.net", totalUsdCents: 0 });
  });

  test("sorts a negative quote ahead of zero because the comparator is numeric subtraction", async () => {
    const { client } = scriptedAuthed([
      checkOk("n.com", true, 0),
      checkOk("n.net", true, -1),
    ]);
    const result = await quoteCheapestAvailableDomain(client, "app-1", "n", [
      "com",
      "net",
    ]);
    expect(result.domain).toBe("n.net");
    expect(result.totalUsdCents).toBe(-1);
  });

  test("throws when a check returns a non-200 status", async () => {
    const { client } = scriptedAuthed([
      { status: 503, json: { success: false, error: "warming" } },
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "slug", ["com"]),
    ).rejects.toThrow(
      'domains/check failed for slug.com: HTTP 503 {"success":false,"error":"warming"}',
    );
  });

  test("throws when a 200 check envelope is not success:true", async () => {
    const { client } = scriptedAuthed([
      { status: 200, json: { success: false, error: "nope" } },
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "slug", ["com"]),
    ).rejects.toThrow(/domains\/check failed for slug.com: HTTP 200/);
  });

  test("stops at the first failed check and does not score later TLDs", async () => {
    const { client, calls } = scriptedAuthed([
      checkOk("x.com", true, 10),
      { status: 500, json: { error: "boom" } },
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "x", ["com", "net"]),
    ).rejects.toThrow("domains/check failed for x.net: HTTP 500");
    expect(calls).toHaveLength(2);
  });

  test("requires available === true, not a truthy stand-in", async () => {
    const { client } = scriptedAuthed([
      {
        status: 200,
        json: { success: true, available: 1, price: { totalUsdCents: 10 } },
      },
    ]);
    await expect(
      quoteCheapestAvailableDomain(client, "app-1", "slug", ["com"]),
    ).rejects.toThrow(/no candidate domain is available \(or priced\)/);
  });
});

describe("getBalanceUsd", () => {
  test("returns a numeric balance including zero", async () => {
    const { client, calls } = scriptedAuthed([
      { status: 200, json: { balance: 0 } },
    ]);
    await expect(getBalanceUsd(client)).resolves.toBe(0);
    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/credits/balance", body: undefined },
    ]);
  });

  test("throws on a non-200 status", async () => {
    const { client } = scriptedAuthed([
      { status: 401, json: { error: "unauth" } },
    ]);
    await expect(getBalanceUsd(client)).rejects.toThrow(
      'credits/balance failed: HTTP 401 {"error":"unauth"}',
    );
  });

  test("throws when balance is present but not a number", async () => {
    const { client } = scriptedAuthed([
      { status: 200, json: { balance: "12.00" } },
    ]);
    await expect(getBalanceUsd(client)).rejects.toThrow(
      'credits/balance failed: HTTP 200 {"balance":"12.00"}',
    );
  });
});

describe("createApp", () => {
  test("returns the id on HTTP 201 and sends the default placeholder URL", async () => {
    const { client, calls } = scriptedAuthed([
      {
        status: 201,
        json: { success: true, app: { id: "app-created" } },
      },
    ]);
    await expect(createApp(client, "demo")).resolves.toBe("app-created");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/apps",
      body: {
        name: "demo",
        app_url: "https://placeholder.invalid",
        skipGitHubRepo: true,
      },
    });
  });

  test("accepts HTTP 200 and forwards a custom app URL", async () => {
    const { client, calls } = scriptedAuthed([
      { status: 200, json: { app: { id: "app-200" } } },
    ]);
    await expect(
      createApp(client, "named", "https://app.example.test"),
    ).resolves.toBe("app-200");
    expect(calls[0]?.body).toMatchObject({
      name: "named",
      app_url: "https://app.example.test",
    });
  });

  test("throws when status is 200/201 but app.id is missing", async () => {
    const { client } = scriptedAuthed([
      { status: 201, json: { success: true } },
    ]);
    await expect(createApp(client, "demo")).rejects.toThrow(
      "apps.create failed: HTTP 201",
    );
  });

  test("throws on any status other than 200 or 201", async () => {
    const { client } = scriptedAuthed([
      { status: 409, json: { error: "exists" } },
    ]);
    await expect(createApp(client, "demo")).rejects.toThrow(
      'apps.create failed: HTTP 409 {"error":"exists"}',
    );
  });
});

describe("deployAppToReady", () => {
  test("throws when deploy does not start as 202 BUILDING", async () => {
    const { client } = scriptedAuthed([
      { status: 200, json: { status: "BUILDING" } },
    ]);
    await expect(
      deployAppToReady(client, "app-1", { pollIntervalMs: 1, capMs: 50 }),
    ).rejects.toThrow("apps.deploy failed to start: HTTP 200");
  });

  test("throws when 202 is returned with a non-BUILDING status", async () => {
    const { client } = scriptedAuthed([
      { status: 202, json: { status: "READY" } },
    ]);
    await expect(
      deployAppToReady(client, "app-1", { pollIntervalMs: 1, capMs: 50 }),
    ).rejects.toThrow("apps.deploy failed to start: HTTP 202");
  });

  test("returns vercelUrl on the first READY poll and invokes tick", async () => {
    let ticks = 0;
    const { client, calls } = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      {
        status: 200,
        json: { status: "READY", vercelUrl: "https://app.vercel.test" },
      },
    ]);
    await expect(
      deployAppToReady(client, "app-1", {
        body: { ref: "main" },
        tick: async () => {
          ticks += 1;
        },
        pollIntervalMs: 1,
        capMs: 200,
      }),
    ).resolves.toBe("https://app.vercel.test");
    expect(ticks).toBe(1);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/apps/app-1/deploy",
      body: { ref: "main" },
    });
    expect(calls[1]).toEqual({
      method: "GET",
      path: "/api/v1/apps/app-1/deploy/status",
      body: undefined,
    });
  });

  test("keeps polling through BUILDING and DRAFT until READY", async () => {
    const { client } = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      { status: 200, json: { status: "BUILDING" } },
      { status: 200, json: { status: "DRAFT" } },
      {
        status: 200,
        json: { status: "READY", vercelUrl: "https://ready.test" },
      },
    ]);
    await expect(
      deployAppToReady(client, "app-1", { pollIntervalMs: 1, capMs: 500 }),
    ).resolves.toBe("https://ready.test");
  });

  test("throws when a status poll is not HTTP 200", async () => {
    const { client } = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      { status: 502, json: { error: "bad gateway" } },
    ]);
    await expect(
      deployAppToReady(client, "app-1", { pollIntervalMs: 1, capMs: 200 }),
    ).rejects.toThrow("deploy/status failed: HTTP 502");
  });

  test("throws on ERROR using the envelope error, or unknown error when missing", async () => {
    const named = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      { status: 200, json: { status: "ERROR", error: "compile failed" } },
    ]);
    await expect(
      deployAppToReady(named.client, "app-1", {
        pollIntervalMs: 1,
        capMs: 200,
      }),
    ).rejects.toThrow("deploy failed: compile failed");

    const unnamed = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      { status: 200, json: { status: "ERROR" } },
    ]);
    await expect(
      deployAppToReady(unnamed.client, "app-1", {
        pollIntervalMs: 1,
        capMs: 200,
      }),
    ).rejects.toThrow("deploy failed: unknown error");
  });

  test("throws when READY arrives without a vercelUrl", async () => {
    const { client } = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      { status: 200, json: { status: "READY", vercelUrl: "" } },
    ]);
    await expect(
      deployAppToReady(client, "app-1", { pollIntervalMs: 1, capMs: 200 }),
    ).rejects.toThrow(
      /deploy did not reach READY with a production_url within 200ms/,
    );
  });

  test("throws when the cap elapses while still BUILDING", async () => {
    const { client } = scriptedAuthed([
      { status: 202, json: { status: "BUILDING" } },
      { status: 200, json: { status: "BUILDING" } },
      { status: 200, json: { status: "BUILDING" } },
      { status: 200, json: { status: "BUILDING" } },
    ]);
    await expect(
      deployAppToReady(client, "app-1", { pollIntervalMs: 5, capMs: 8 }),
    ).rejects.toThrow(
      /deploy did not reach READY with a production_url within 8ms/,
    );
  });
});

describe("buyDomain", () => {
  test("forwards POST /domains/buy and returns the raw envelope, including errors", async () => {
    const { client, calls } = scriptedAuthed([
      {
        status: 402,
        json: {
          success: false,
          error: "insufficient credits",
          code: "PAYMENT",
        },
      },
    ]);
    await expect(buyDomain(client, "app-1", "buy.test")).resolves.toEqual({
      status: 402,
      json: {
        success: false,
        error: "insufficient credits",
        code: "PAYMENT",
      },
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/apps/app-1/domains/buy",
        body: { domain: "buy.test" },
      },
    ]);
  });
});

describe("pollDomainActive", () => {
  test("returns on the first active+verified poll", async () => {
    const { client, calls } = scriptedAuthed([
      {
        status: 200,
        json: {
          success: true,
          status: "active",
          verified: true,
          domain: "d.test",
        },
      },
    ]);
    await expect(
      pollDomainActive(client, "app-1", "d.test", {
        pollIntervalMs: 1,
        capMs: 200,
      }),
    ).resolves.toEqual({
      success: true,
      status: "active",
      verified: true,
      domain: "d.test",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/apps/app-1/domains/status",
        body: { domain: "d.test" },
      },
    ]);
  });

  test("does not treat active-but-unverified or verified-but-pending as done", async () => {
    const { client } = scriptedAuthed([
      { status: 200, json: { status: "active", verified: false } },
      { status: 200, json: { status: "pending", verified: true } },
      { status: 200, json: { status: "active", verified: true } },
    ]);
    const latest = await pollDomainActive(client, "app-1", "d.test", {
      pollIntervalMs: 1,
      capMs: 500,
    });
    expect(latest).toEqual({ status: "active", verified: true });
  });

  test("throws on a non-200 status poll", async () => {
    const { client } = scriptedAuthed([
      { status: 404, json: { error: "missing" } },
    ]);
    await expect(
      pollDomainActive(client, "app-1", "d.test", {
        pollIntervalMs: 1,
        capMs: 200,
      }),
    ).rejects.toThrow('domains/status failed: HTTP 404 {"error":"missing"}');
  });

  test("throws immediately when capMs is 0, with the empty latest snapshot", async () => {
    const { client, calls } = scriptedAuthed([]);
    await expect(
      pollDomainActive(client, "app-1", "d.test", {
        pollIntervalMs: 1,
        capMs: 0,
      }),
    ).rejects.toThrow(
      "domain d.test did not reach active+verified within 0ms (last: {})",
    );
    expect(calls).toEqual([]);
  });

  test("throws when the cap elapses before active+verified", async () => {
    const { client } = scriptedAuthed([
      { status: 200, json: { status: "pending", verified: false } },
      { status: 200, json: { status: "pending", verified: false } },
    ]);
    await expect(
      pollDomainActive(client, "app-1", "slow.test", {
        pollIntervalMs: 5,
        capMs: 8,
      }),
    ).rejects.toThrow(
      /domain slow.test did not reach active\+verified within 8ms/,
    );
  });
});

describe("probeUrlServes", () => {
  test("returns ok:false with attempts 0 when capMs is 0 (loop never entered)", async () => {
    const result = await probeUrlServes(["http://127.0.0.1:1/"], {
      pollIntervalMs: 1,
      capMs: 0,
    });
    expect(result).toEqual({
      ok: false,
      url: "http://127.0.0.1:1/",
      httpStatus: null,
      attempts: 0,
      lastError: undefined,
    });
  });

  test("succeeds on the first HTTP status below 500", async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 404;
      res.end("missing");
    });
    const result = await probeUrlServes([server.url], {
      pollIntervalMs: 1,
      capMs: 500,
    });
    expect(result).toEqual({
      ok: true,
      url: server.url,
      httpStatus: 404,
      attempts: 1,
    });
  });

  test("skips HTTP 500+ responses and later accepts a healthy candidate", async () => {
    let hits = 0;
    const failing = await listen((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const healthy = await listen((_req, res) => {
      hits += 1;
      res.statusCode = 200;
      res.end("ok");
    });
    const result = await probeUrlServes([failing.url, healthy.url], {
      pollIntervalMs: 1,
      capMs: 500,
    });
    expect(result.ok).toBe(true);
    expect(result.url).toBe(healthy.url);
    expect(result.httpStatus).toBe(200);
    expect(result.attempts).toBe(2);
    expect(hits).toBe(1);
  });

  test("records a connection error and times out with the first URL", async () => {
    const result = await probeUrlServes(["http://127.0.0.1:1/"], {
      pollIntervalMs: 5,
      capMs: 12,
    });
    expect(result.ok).toBe(false);
    expect(result.url).toBe("http://127.0.0.1:1/");
    expect(result.httpStatus).toBeNull();
    expect(result.attempts).toBeGreaterThan(0);
    expect(result.lastError).toMatch(/127\.0\.0\.1:1/);
  });
});

describe("detachDomain and deleteApp", () => {
  test("detachDomain DELETE-forwards the domain and returns the raw status, including a missing item", async () => {
    const { client, calls } = scriptedAuthed([{ status: 404, json: {} }]);
    await expect(detachDomain(client, "app-1", "gone.test")).resolves.toBe(404);
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/api/v1/apps/app-1/domains",
        body: { domain: "gone.test" },
      },
    ]);
  });

  test("deleteApp DELETE-forwards the app id and returns the raw status", async () => {
    const { client, calls } = scriptedAuthed([{ status: 204, json: {} }]);
    await expect(deleteApp(client, "app-1")).resolves.toBe(204);
    expect(calls).toEqual([
      { method: "DELETE", path: "/api/v1/apps/app-1", body: undefined },
    ]);
  });
});
