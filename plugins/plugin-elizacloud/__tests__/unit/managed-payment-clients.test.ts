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
      ELIZAOS_CLOUD_BASE_URL: "https://cloud.example/api",
    });

    expect(config.configured).toBe(true);
    expect(config.apiKey).toBe("eliza_test");
    expect(config.apiBaseUrl).toContain("cloud.example");
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
      apiBaseUrl: "https://cloud.example/api",
      siteUrl: "https://cloud.example",
    }));

    await expect(client.createLinkToken()).resolves.toMatchObject({
      linkToken: "link-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example/api/v1/eliza/plaid/link-token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer eliza_test",
        }),
      })
    );
  });

  it("surfaces Plaid errors as typed client errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ message: "Plaid unavailable" }, { status: 503 })
      )
    );

    const client = new PlaidManagedClient(() => ({
      configured: true,
      apiKey: "eliza_test",
      apiBaseUrl: "https://cloud.example/api",
      siteUrl: "https://cloud.example",
    }));

    await expect(client.createLinkToken()).rejects.toBeInstanceOf(PlaidManagedClientError);
    await expect(client.createLinkToken()).rejects.toMatchObject({
      status: 503,
      message: "Plaid unavailable",
    });
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
      apiBaseUrl: "https://cloud.example/api",
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

  it("fails before fetch when cloud auth is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const paypal = new PaypalManagedClient(() => ({
      configured: false,
      apiKey: null,
      apiBaseUrl: "https://cloud.example/api",
      siteUrl: "https://cloud.example",
    }));

    await expect(paypal.buildAuthorizeUrl({ state: "state" })).rejects.toThrow(
      PaypalManagedClientError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
