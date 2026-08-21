/**
 * Exercises Plaid's real HTTP protocol boundary with deterministic fetch
 * responses, including malformed data, rate limits, and environment binding.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  AgentPlaidConnectorError,
  exchangePlaidPublicToken,
  getPlaidEnvironment,
  removePlaidItem,
} from "./agent-plaid-connector";

const originalEnvironment = process.env.PLAID_ENV;
const originalClientId = process.env.PLAID_CLIENT_ID;
const originalSecret = process.env.PLAID_SECRET;
const originalSandboxSecret = process.env.PLAID_SANDBOX_SECRET;
const originalDevelopmentSecret = process.env.PLAID_DEVELOPMENT_SECRET;
const originalProductionSecret = process.env.PLAID_PRODUCTION_SECRET;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = originalEnvironment;
  if (originalClientId === undefined) delete process.env.PLAID_CLIENT_ID;
  else process.env.PLAID_CLIENT_ID = originalClientId;
  if (originalSecret === undefined) delete process.env.PLAID_SECRET;
  else process.env.PLAID_SECRET = originalSecret;
  if (originalSandboxSecret === undefined) delete process.env.PLAID_SANDBOX_SECRET;
  else process.env.PLAID_SANDBOX_SECRET = originalSandboxSecret;
  if (originalDevelopmentSecret === undefined) delete process.env.PLAID_DEVELOPMENT_SECRET;
  else process.env.PLAID_DEVELOPMENT_SECRET = originalDevelopmentSecret;
  if (originalProductionSecret === undefined) delete process.env.PLAID_PRODUCTION_SECRET;
  else process.env.PLAID_PRODUCTION_SECRET = originalProductionSecret;
  globalThis.fetch = originalFetch;
});

function configurePlaid(environment = "sandbox"): void {
  process.env.PLAID_CLIENT_ID = "client-id";
  process.env.PLAID_SECRET = "server-secret";
  process.env.PLAID_ENV = environment;
  delete process.env.PLAID_SANDBOX_SECRET;
  delete process.env.PLAID_DEVELOPMENT_SECRET;
  delete process.env.PLAID_PRODUCTION_SECRET;
}

describe("agent Plaid connector protocol boundary", () => {
  test("rejects an unknown environment instead of silently using sandbox", () => {
    configurePlaid("staging");
    expect(() => getPlaidEnvironment()).toThrow(
      "PLAID_ENV must be sandbox, development, or production.",
    );
  });

  test("parses a protocol-faithful exchange response", async () => {
    configurePlaid();
    globalThis.fetch = mock(async () =>
      Response.json({ access_token: "access-sandbox-1", item_id: "item-1" }),
    ) as typeof fetch;

    await expect(exchangePlaidPublicToken({ publicToken: "public-sandbox-1" })).resolves.toEqual({
      accessToken: "access-sandbox-1",
      itemId: "item-1",
    });
  });

  test("removes an Item from its stored environment after the process environment changes", async () => {
    configurePlaid("production");
    process.env.PLAID_SANDBOX_SECRET = "sandbox-server-secret";
    let requestedUrl = "";
    let requestedBody = "";
    globalThis.fetch = mock(async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return Response.json({ request_id: "request-1" });
    }) as typeof fetch;

    await removePlaidItem({
      accessToken: "access-sandbox-1",
      environment: "sandbox",
    });

    expect(requestedUrl).toBe("https://sandbox.plaid.com/item/remove");
    expect(JSON.parse(requestedBody)).toMatchObject({
      secret: "sandbox-server-secret",
      access_token: "access-sandbox-1",
    });
  });

  test("never sends the active environment secret to a stored different environment", async () => {
    configurePlaid("production");
    delete process.env.PLAID_SANDBOX_SECRET;
    const fetchMock = mock(async () => Response.json({ request_id: "must-not-run" }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      removePlaidItem({
        accessToken: "access-sandbox-1",
        environment: "sandbox",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fails closed on malformed successful upstream data", async () => {
    configurePlaid();
    globalThis.fetch = mock(async () => Response.json({ item_id: "item-1" })) as typeof fetch;

    await expect(
      exchangePlaidPublicToken({ publicToken: "public-sandbox-1" }),
    ).rejects.toMatchObject({
      status: 502,
      code: "MALFORMED_RESPONSE",
    } satisfies Partial<AgentPlaidConnectorError>);
  });

  test("preserves rate-limit status and code without exposing credentials", async () => {
    configurePlaid();
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error_code: "RATE_LIMIT_EXCEEDED",
          error_message: "Try again later.",
        },
        { status: 429 },
      ),
    ) as typeof fetch;

    let caught: unknown;
    try {
      await exchangePlaidPublicToken({ publicToken: "public-sandbox-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      status: 429,
      code: "RATE_LIMIT_EXCEEDED",
      message: "Try again later.",
    });
    expect(JSON.stringify(caught)).not.toContain("server-secret");
    expect(JSON.stringify(caught)).not.toContain("public-sandbox-1");
  });

  test("redacts request credentials echoed by an upstream error", async () => {
    configurePlaid();
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error_code: "INVALID_INPUT",
          error_message: "public-sandbox-1 server-secret client-id must not cross the boundary",
        },
        { status: 400 },
      ),
    ) as typeof fetch;

    let caught: unknown;
    try {
      await exchangePlaidPublicToken({ publicToken: "public-sandbox-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(JSON.stringify(caught)).not.toContain("public-sandbox-1");
    expect(JSON.stringify(caught)).not.toContain("server-secret");
    expect(JSON.stringify(caught)).not.toContain("client-id");
  });

  test("translates provider transport failures without exposing fetch details", async () => {
    configurePlaid();
    globalThis.fetch = mock(async () => {
      throw new TypeError("request with public-sandbox-1 and server-secret failed");
    }) as typeof fetch;

    await expect(
      exchangePlaidPublicToken({ publicToken: "public-sandbox-1" }),
    ).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_UNAVAILABLE",
      message: "Plaid /item/public_token/exchange was unreachable.",
    } satisfies Partial<AgentPlaidConnectorError>);
  });

  test("preserves revoked-auth errors without exposing the Item token", async () => {
    configurePlaid();
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "The login details changed.",
        },
        { status: 400 },
      ),
    ) as typeof fetch;

    let caught: unknown;
    try {
      await exchangePlaidPublicToken({ publicToken: "revoked-public-token" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      status: 400,
      code: "ITEM_LOGIN_REQUIRED",
    });
    expect(JSON.stringify(caught)).not.toContain("revoked-public-token");
  });

  test("bounds malformed upstream failure bodies", async () => {
    configurePlaid();
    globalThis.fetch = mock(
      async () => new Response("upstream unavailable", { status: 500 }),
    ) as typeof fetch;

    await expect(
      exchangePlaidPublicToken({ publicToken: "public-sandbox-1" }),
    ).rejects.toMatchObject({
      status: 500,
      code: null,
      message: "Plaid /item/public_token/exchange failed with 500",
    });
  });
});
