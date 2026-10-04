import { afterEach, describe, expect, test } from "bun:test";
import { LoginClient } from "../client.ts";

const originalFetch = globalThis.fetch;
function stubFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
}
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const client = new LoginClient({
  baseUrl: "https://login.example.test",
  apiKey: "fixture",
});
function respond(body: unknown, status = 200) {
  stubFetch(() => Promise.resolve(Response.json(body, { status })));
}

describe("login response boundary", () => {
  test("rejects HTTP failures even when the body claims success", async () => {
    respond({ ok: true, data: [] }, 503);
    await expect(client.getPolicies("agent")).rejects.toMatchObject({
      name: "LoginApiError",
      status: 503,
    });
  });
  test.each(
    [null, [], true, "success", {}, { ok: "true", data: [] }].map((body) => ({
      body,
    })),
  )("rejects malformed envelopes %j", async ({ body }) => {
    respond(body);
    await expect(client.getPolicies("agent")).rejects.toMatchObject({
      name: "LoginApiError",
      status: 200,
    });
  });
  test("preserves a successful empty policy list", async () => {
    respond({ ok: true, data: [] });
    expect(await client.getPolicies("agent")).toEqual([]);
  });
  test("preserves structured authorization failures", async () => {
    respond(
      { ok: false, error: "Step up required", data: { mfaRequired: true } },
      403,
    );
    await expect(client.getPolicies("agent")).rejects.toMatchObject({
      status: 403,
      mfaRequired: true,
      data: { mfaRequired: true },
    });
  });
});

describe("bounded transport shared by login and CSV", () => {
  test("waits for asynchronous signing headers", async () => {
    const { fetchLoginJson } = await import("../transport");
    let authorization: string | null = null;
    stubFetch((_url: unknown, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return Promise.resolve(Response.json({ ok: true }));
    });
    await fetchLoginJson(
      "https://login.example.test",
      {},
      {},
      async () => new Headers({ Authorization: "Bearer signed" }),
    );
    expect<string | null>(authorization).toBe("Bearer signed");
  });

  test("cancels a stalled body and releases the reader", async () => {
    const { fetchLoginText } = await import("../transport");
    let cancelled = false;
    stubFetch(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    );
    await expect(
      fetchLoginText(
        "https://login.example.test",
        {},
        { requestTimeoutMs: 20 },
      ),
    ).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });

  test("already cancelled calls do not fetch", async () => {
    const { fetchLoginText } = await import("../transport");
    let calls = 0;
    stubFetch(() => {
      calls++;
      return Promise.resolve(new Response());
    });
    await expect(
      fetchLoginText("https://login.example.test", {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
  });

  test("CSV exports reject oversized streamed bodies", async () => {
    const limited = new LoginClient({
      baseUrl: "https://login.example.test",
      bearerToken: "fixture",
      maxResponseBodyBytes: 4,
    });
    stubFetch(() => Promise.resolve(new Response("a,b,c\n")));
    await expect(limited.exportTenantUsersCsv("tenant")).rejects.toThrow(
      "size limit",
    );
  });

  test("CSV exports return text through the same transport", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("id,email\n1,test@example.test\n")),
    );
    expect(await client.exportTenantUsersCsv("tenant")).toBe(
      "id,email\n1,test@example.test\n",
    );
  });

  test("login rejects malformed scalar responses", async () => {
    const { LoginAuth } = await import("../auth");
    respond(null);
    await expect(
      new LoginAuth({ baseUrl: "https://login.example.test" }).getProviders(),
    ).rejects.toMatchObject({ name: "LoginApiError", status: 200 });
  });
});

test("data-returning methods reject missing data while void methods accept success", async () => {
  respond({ ok: true });
  await expect(client.getPolicies("agent")).rejects.toThrow(
    "missing required data",
  );
  await expect(
    client.removeTenantUser("tenant", "user"),
  ).resolves.toBeUndefined();
});
