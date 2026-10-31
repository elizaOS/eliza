/**
 * A Steward read that fails upstream is not the same answer as "no such agent".
 * `getStewardAgent` is used by the agent detail/compat routes to decide whether a
 * Docker-backed agent has a Steward wallet, and `stewardFetch` turned every 4xx
 * (401/403/429) and 5xx and every transport failure into `null` — the same value
 * it returns for a genuine 404. A rate-limited or down Steward therefore made the
 * routes report an existing wallet as missing, with no way for the caller to tell
 * the two cases apart.
 */
import { afterEach, expect, test } from "bun:test";
import { getStewardAgent, getStewardWalletInfo } from "./steward-client";

const realFetch = globalThis.fetch;

process.env.LOGIN_API_URL = "https://steward.test";
process.env.STEWARD_TENANT_ID = "tenant-test";

const options = { tenantId: "tenant-test", apiKey: "test-key" };

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => handler()) as typeof fetch;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

test("rejects when Steward answers 503 instead of reporting the agent absent", async () => {
  stubFetch(() => new Response("upstream down", { status: 503 }));

  const error = await rejection(getStewardAgent("agent-503", options));

  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe("STEWARD_READ_UNAVAILABLE");
});

test("rejects when Steward rate-limits the read", async () => {
  stubFetch(() => new Response("slow down", { status: 429 }));

  const error = await rejection(getStewardAgent("agent-429", options));

  expect((error as { code?: string }).code).toBe("STEWARD_READ_UNAVAILABLE");
  expect((error as { context?: { status?: number } }).context?.status).toBe(429);
});

test("rejects when the Steward request never completes", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const error = await rejection(getStewardAgent("agent-network", options));

  expect((error as { code?: string }).code).toBe("STEWARD_READ_UNAVAILABLE");
});

test("keeping 404 as the absent-agent answer", async () => {
  stubFetch(() => new Response("not found", { status: 404 }));

  expect(await getStewardAgent("agent-missing", options)).toBeNull();
});

test("wallet summary still degrades to null so its DB fallback keeps working", async () => {
  stubFetch(() => new Response("upstream down", { status: 503 }));

  expect(await getStewardWalletInfo("agent-wallet", options)).toBeNull();
});
