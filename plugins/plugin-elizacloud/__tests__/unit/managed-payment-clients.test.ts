/**
 * Verifies managed payment clients use generated Cloud routes, keep Plaid
 * credentials opaque, and reject malformed Cloud responses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaypalManagedClient,
  PaypalManagedClientError,
  PlaidManagedClient,
  PlaidManagedClientError,
  resolveEnvElizaCloudManagedClientConfig,
} from "../../src/cloud/managed-payment-clients";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed payment clients", () => {
  it("normalizes cloud config from env without accepting redacted keys", () => {
    expect(
      resolveEnvElizaCloudManagedClientConfig({
        ELIZAOS_CLOUD_API_KEY: " [REDACTED] ",
      }).configured
    ).toBe(false);

    const config = resolveEnvElizaCloudManagedClientConfig({
      ELIZAOS_CLOUD_API_KEY: " eliza_test ",
      ELIZAOS_CLOUD_BASE_URL: "https://cloud.example",
    });

    expect(config.configured).toBe(true);
    expect(config.apiKey).toBe("eliza_test");
    // Pin the whole resolved base, not just the host: the clients append bare
    // route paths, so the `/api/v1` prefix has to come from here or every
    // managed-payment request 404s against the generated router.
    expect(config.apiBaseUrl).toBe("https://cloud.example/api/v1");
    expect(
      resolveEnvElizaCloudManagedClientConfig({
        ELIZAOS_CLOUD_API_KEY: "eliza_test",
        ELIZAOS_CLOUD_BASE_URL: "https://cloud.example/api/v1",
      }).apiBaseUrl
    ).toBe("https://cloud.example/api/v1");
  });

  it("posts Plaid link token requests through the configured cloud API", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        linkToken: "link-token",
        expiration: "2026-01-01T00:00:00.000Z",
        environment: "sandbox",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlaidManagedClient(() => ({
      configured: true,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    await expect(client.createLinkToken()).resolves.toMatchObject({
      linkToken: "link-token",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://cloud.example/api/v1/eliza/plaid/link-token");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer eliza_test");
  });

  it("uses opaque Plaid connection ids without transporting access tokens", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/exchange")) {
        return Response.json({
          connectionId: "11111111-1111-4111-8111-111111111111",
          connectionCreated: true,
          environment: "sandbox",
          institution: {
            institutionId: "ins-1",
            institutionName: "Test Bank",
            primaryAccountMask: "1234",
            accounts: [],
          },
        });
      }
      return Response.json({
        added: [],
        modified: [],
        removed: [],
        nextCursor: "cursor-2",
        hasMore: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PlaidManagedClient(() => ({
      configured: true,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    const exchange = await client.exchangePublicToken({ publicToken: "public-token" });
    await client.syncTransactions({
      connectionId: exchange.connectionId,
      cursor: "cursor-1",
    });

    const payloads = fetchMock.mock.calls.map(([, init]) => String(init?.body));
    expect(payloads).toContain(
      JSON.stringify({
        connectionId: "11111111-1111-4111-8111-111111111111",
        cursor: "cursor-1",
        count: 250,
      })
    );
    expect(payloads.join("\n")).not.toContain("accessToken");
    expect(payloads.join("\n")).not.toContain("plaid-secret");
  });

  it("surfaces Plaid errors as typed client errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { message: "Plaid unavailable", code: "ITEM_LOGIN_REQUIRED" },
          { status: 503 }
        )
      )
    );

    const client = new PlaidManagedClient(() => ({
      configured: true,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    await expect(client.createLinkToken()).rejects.toBeInstanceOf(PlaidManagedClientError);
    await expect(client.createLinkToken()).rejects.toMatchObject({
      status: 503,
      message: "Plaid unavailable",
      code: "ITEM_LOGIN_REQUIRED",
    });
  });

  it("redacts Cloud authentication and Link credentials echoed in errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            message: "eliza_secret_key public-secret-token must not escape",
            code: "INVALID_INPUT",
          },
          { status: 400 }
        )
      )
    );
    const client = new PlaidManagedClient(() => ({
      configured: true,
      apiKey: "eliza_secret_key",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    let caught: unknown;
    try {
      await client.exchangePublicToken({ publicToken: "public-secret-token" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(JSON.stringify(caught)).not.toContain("eliza_secret_key");
    expect(JSON.stringify(caught)).not.toContain("public-secret-token");
  });

  it("rejects malformed successful Plaid responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          connectionId: "not-an-opaque-uuid",
          accessToken: "must-not-enter-runtime-data",
        })
      )
    );

    const client = new PlaidManagedClient(() => ({
      configured: true,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    await expect(client.exchangePublicToken({ publicToken: "public-token" })).rejects.toMatchObject(
      {
        status: 502,
        message: "Eliza Cloud returned malformed Plaid data.",
      } satisfies Partial<PlaidManagedClientError>
    );
  });

  it("preserves PayPal csv fallback hints on merchant API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ message: "Reporting unavailable", fallback: "csv_export" }, { status: 403 })
      )
    );

    const client = new PaypalManagedClient(() => ({
      configured: true,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    await expect(
      client.searchTransactions({
        accessToken: "paypal-token",
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-01-31T00:00:00Z",
      })
    ).rejects.toMatchObject({
      status: 403,
      message: "Reporting unavailable",
      fallback: "csv_export",
    } satisfies Partial<PaypalManagedClientError>);
  });

  it("preserves complete plain-text provider errors", async () => {
    const suffix = "DISTINGUISHING-PROVIDER-SUFFIX";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response(`${"x".repeat(10_000)}${suffix}`, { status: 503 })
      )
    );
    const config = () => ({
      configured: true as const,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    });

    const plaidError = await new PlaidManagedClient(config)
      .createLinkToken()
      .catch((thrown: unknown) => thrown as PlaidManagedClientError);
    const paypalError = await new PaypalManagedClient(config)
      .buildAuthorizeUrl({ state: "state" })
      .catch((thrown: unknown) => thrown as PaypalManagedClientError);

    expect(plaidError.message).toContain(suffix);
    expect(paypalError.message).toContain(suffix);
  });

  it("fails before fetch when cloud auth is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const paypal = new PaypalManagedClient(() => ({
      configured: false,
      apiKey: null,
      apiBaseUrl: "https://cloud.example/api/v1",
      siteUrl: "https://cloud.example",
    }));

    await expect(paypal.buildAuthorizeUrl({ state: "state" })).rejects.toThrow(
      PaypalManagedClientError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
