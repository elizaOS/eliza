/**
 * Integration tests for the Duffel flight search adapter.
 *
 * Live tests are gated on DUFFEL_API_KEY being set. When the env var is absent
 * the suite skips — consistent with the credential-gated pattern used across
 * this test directory.
 *
 * Unit-level tests (config parsing, error paths, response mapping) always run.
 *
 * ---------------------------------------------------------------------------
 * AlwaysSkipped in CI
 * ---------------------------------------------------------------------------
 * The `searchFlights — live Duffel` describe block at the bottom of this
 * file is `describe.skipIf(!LIVE_API_KEY)`. DUFFEL_API_KEY is not
 * configured in any GitHub Actions workflow (see .github/workflows/*.yml —
 * no match for DUFFEL_API_KEY), so the live block is always skipped in CI
 * today. It is kept here to document the live contract and to run locally
 * against the Duffel test environment.
 *
 * To run locally:
 *   DUFFEL_API_KEY=duffel_test_xxx ELIZA_DUFFEL_DIRECT=1 \
 *     bunx vitest run plugins/app-lifeops/test/travel-duffel.integration.test.ts
 *
 * Use a Duffel TEST-mode key (prefix `duffel_test_`). Do NOT wire a live
 * API key into CI — search requests count against account quota and
 * order/payment endpoints touch real booking infrastructure. For CI
 * coverage of the HTTP layer, rely on the fetch-mocked tests in this
 * file (covering search, order, payment mapping) and/or add an offline
 * harness with a local HTTP server stub in a follow-up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CreateDuffelOrderRequest,
  createOrder,
  createPayment,
  DuffelConfigError,
  type DuffelOffer,
  getOffer,
  getOrder,
  readDuffelConfigFromEnv,
  type SearchFlightsRequest,
  searchFlights,
} from "../src/lifeops/travel-adapters/duffel.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.DUFFEL_API_KEY;
  delete process.env.ELIZA_DUFFEL_DIRECT;
  // Force direct mode for the existing fetch-mocking tests below; the
  // cloud-relay path is exercised in duffel-cloud-relay.test.ts at the
  // route layer.
  process.env.ELIZA_DUFFEL_DIRECT = "1";
});

afterEach(() => {
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config parsing — always runs
// ---------------------------------------------------------------------------

describe("readDuffelConfigFromEnv (direct mode)", () => {
  it("throws DuffelConfigError when ELIZA_DUFFEL_DIRECT=1 but DUFFEL_API_KEY is absent", () => {
    delete process.env.DUFFEL_API_KEY;
    expect(() => readDuffelConfigFromEnv()).toThrow(DuffelConfigError);
    expect(() => readDuffelConfigFromEnv()).toThrow(/DUFFEL_API_KEY/);
  });

  it("returns direct-mode config with apiKey when env var is set", () => {
    process.env.DUFFEL_API_KEY = "duffel_live_test_key";
    const config = readDuffelConfigFromEnv();
    expect(config.mode).toBe("direct");
    expect(config.apiKey).toBe("duffel_live_test_key");
    expect(config.cloudRelayBaseUrl).toBeNull();
  });

  it("trims whitespace from apiKey", () => {
    process.env.DUFFEL_API_KEY = "  duffel_key_trimmed  ";
    const config = readDuffelConfigFromEnv();
    expect(config.apiKey).toBe("duffel_key_trimmed");
  });
});

describe("readDuffelConfigFromEnv (cloud mode default)", () => {
  it("returns cloud-mode config when ELIZA_DUFFEL_DIRECT is unset", () => {
    delete process.env.ELIZA_DUFFEL_DIRECT;
    delete process.env.DUFFEL_API_KEY;
    const config = readDuffelConfigFromEnv();
    expect(config.mode).toBe("cloud");
    expect(config.apiKey).toBeNull();
    expect(config.cloudRelayBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("honours ELIZA_API_PORT for the local relay base URL", () => {
    delete process.env.ELIZA_DUFFEL_DIRECT;
    delete process.env.DUFFEL_API_KEY;
    const config = readDuffelConfigFromEnv({
      ELIZA_API_PORT: "31999",
    } as NodeJS.ProcessEnv);
    expect(config.mode).toBe("cloud");
    expect(config.cloudRelayBaseUrl).toBe("http://127.0.0.1:31999");
  });
});

// ---------------------------------------------------------------------------
// searchFlights error paths — always runs (no network)
// ---------------------------------------------------------------------------

describe("searchFlights — config error", () => {
  it("throws DuffelConfigError when no config passed and env is empty", async () => {
    await expect(
      searchFlights({
        origin: "JFK",
        destination: "LHR",
        departureDate: "2025-06-01",
      }),
    ).rejects.toThrow(DuffelConfigError);
  });
});

describe("searchFlights — network error handling", () => {
  it("throws Error on fetch rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Network failure")),
    );
    process.env.DUFFEL_API_KEY = "fake-key";

    await expect(
      searchFlights({
        origin: "JFK",
        destination: "LHR",
        departureDate: "2025-06-01",
      }),
    ).rejects.toThrow("Network failure");
  });

  it("throws Error on non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }),
    );
    process.env.DUFFEL_API_KEY = "bad-key";

    await expect(
      searchFlights({
        origin: "JFK",
        destination: "LHR",
        departureDate: "2025-06-01",
      }),
    ).rejects.toThrow("401");
  });

  it("maps Duffel offer response fields correctly", async () => {
    const fakeOffer = {
      id: "off_0000Amvq55bMKivq1xTjJD",
      total_amount: "299.50",
      total_currency: "USD",
      expires_at: "2025-05-01T12:00:00Z",
      passengers: [
        {
          id: "pas_123",
          type: "adult",
          given_name: "Tony",
          family_name: "Stark",
        },
      ],
      payment_requirements: {
        requires_instant_payment: false,
        price_guarantee_expires_at: "2025-05-01T18:00:00Z",
        payment_required_by: "2025-05-02T18:00:00Z",
      },
      slices: [
        {
          origin: { iata_code: "JFK" },
          destination: { iata_code: "LHR" },
          duration: "PT7H30M",
          fare_brand_name: "Economy",
          segments: [
            {
              origin: { iata_code: "JFK" },
              destination: { iata_code: "LHR" },
              departing_at: "2025-06-01T09:00:00",
              arriving_at: "2025-06-01T21:30:00",
              operating_carrier: { iata_code: "BA" },
              flight_number: "BA178",
              duration: "PT7H30M",
            },
          ],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "ofr_0000Amvq55bMKivq1xTjJD",
            offers: [fakeOffer],
          },
        }),
      }),
    );
    process.env.DUFFEL_API_KEY = "fake-key";

    const result = await searchFlights({
      origin: "JFK",
      destination: "LHR",
      departureDate: "2025-06-01",
    });

    expect(result.offerRequestId).toBe("ofr_0000Amvq55bMKivq1xTjJD");
    expect(result.offers).toHaveLength(1);

    const offer: DuffelOffer = result.offers[0];
    expect(offer.id).toBe("off_0000Amvq55bMKivq1xTjJD");
    expect(offer.totalAmount).toBe("299.50");
    expect(offer.totalCurrency).toBe("USD");
    expect(offer.passengerCount).toBe(1);
    expect(offer.cabinClass).toBe("Economy");
    expect(offer.passengers[0]?.id).toBe("pas_123");
    expect(offer.paymentRequirements?.requiresInstantPayment).toBe(false);
    expect(offer.slices).toHaveLength(1);
    expect(offer.slices[0].origin).toBe("JFK");
    expect(offer.slices[0].destination).toBe("LHR");
    expect(offer.slices[0].segments[0].carrierIataCode).toBe("BA");
    expect(offer.slices[0].segments[0].flightNumber).toBe("BA178");
  });

  it("sends return slice when returnDate is provided", async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { id: "ofr_x", offers: [] } }),
        });
      }),
    );
    process.env.DUFFEL_API_KEY = "fake-key";

    await searchFlights({
      origin: "LAX",
      destination: "CDG",
      departureDate: "2025-07-01",
      returnDate: "2025-07-15",
    });

    const body = capturedBody as { data: { slices: unknown[] } };
    expect(body.data.slices).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getOffer error paths — always runs
// ---------------------------------------------------------------------------

describe("getOffer — config error", () => {
  it("throws DuffelConfigError when env is empty", async () => {
    await expect(getOffer("off_123")).rejects.toThrow(DuffelConfigError);
  });
});

describe("getOffer — validation", () => {
  it("throws on blank id", async () => {
    process.env.DUFFEL_API_KEY = "fake-key";
    await expect(getOffer("")).rejects.toThrow(/id is required/);
  });
});

// ---------------------------------------------------------------------------
// Order + payment lifecycle — always runs (mocked network)
// ---------------------------------------------------------------------------

describe("createOrder", () => {
  const baseRequest: CreateDuffelOrderRequest = {
    selectedOffers: ["off_123"],
    type: "hold",
    passengers: [
      {
        id: "pas_123",
        givenName: "Tony",
        familyName: "Stark",
        bornOn: "1980-07-24",
        email: "tony@example.com",
        phoneNumber: "+15551234567",
      },
    ],
  };

  it("posts a hold order and maps the response", async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              id: "ord_123",
              booking_reference: "RZPNX8",
              total_amount: "299.50",
              total_currency: "USD",
              slices: [
                {
                  origin: { iata_code: "JFK" },
                  destination: { iata_code: "LHR" },
                  duration: "PT7H30M",
                  segments: [
                    {
                      origin: { iata_code: "JFK" },
                      destination: { iata_code: "LHR" },
                      departing_at: "2025-06-01T09:00:00",
                      arriving_at: "2025-06-01T21:30:00",
                      operating_carrier: { iata_code: "BA" },
                      flight_number: "BA178",
                      duration: "PT7H30M",
                    },
                  ],
                },
              ],
              passengers: [
                { id: "pas_123", given_name: "Tony", family_name: "Stark" },
              ],
              payment_status: {
                awaiting_payment: true,
                payment_required_by: "2025-05-02T18:00:00Z",
                price_guarantee_expires_at: "2025-05-01T18:00:00Z",
              },
              documents: [],
            },
          }),
        });
      }),
    );
    process.env.DUFFEL_API_KEY = "fake-key";

    const order = await createOrder(baseRequest);

    const body = capturedBody as {
      data: {
        type: string;
        selected_offers: string[];
        passengers: Array<Record<string, unknown>>;
      };
    };
    expect(body.data.type).toBe("hold");
    expect(body.data.selected_offers).toEqual(["off_123"]);
    expect(body.data.passengers[0]?.id).toBe("pas_123");
    expect(order.id).toBe("ord_123");
    expect(order.bookingReference).toBe("RZPNX8");
    expect(order.paymentStatus?.awaitingPayment).toBe(true);
  });

  it("throws if no offer is supplied", async () => {
    process.env.DUFFEL_API_KEY = "fake-key";
    await expect(
      createOrder({ ...baseRequest, selectedOffers: [] }),
    ).rejects.toThrow(/exactly one selected offer/);
  });
});

describe("getOrder", () => {
  it("retrieves a held order and maps documents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "ord_123",
            booking_reference: "RZPNX8",
            total_amount: "299.50",
            total_currency: "USD",
            slices: [
              {
                origin: { iata_code: "JFK" },
                destination: { iata_code: "LHR" },
                duration: "PT7H30M",
                segments: [
                  {
                    origin: { iata_code: "JFK" },
                    destination: { iata_code: "LHR" },
                    departing_at: "2025-06-01T09:00:00",
                    arriving_at: "2025-06-01T21:30:00",
                    operating_carrier: { iata_code: "BA" },
                    flight_number: "BA178",
                    duration: "PT7H30M",
                  },
                ],
              },
            ],
            passengers: [
              { id: "pas_123", given_name: "Tony", family_name: "Stark" },
            ],
            payment_status: {
              awaiting_payment: false,
              payment_required_by: "2025-05-02T18:00:00Z",
              price_guarantee_expires_at: "2025-05-01T18:00:00Z",
            },
            documents: [
              {
                type: "electronic_ticket",
                unique_identifier: "123-1230984567",
              },
            ],
          },
        }),
      }),
    );
    process.env.DUFFEL_API_KEY = "fake-key";

    const order = await getOrder("ord_123");

    expect(order.id).toBe("ord_123");
    expect(order.documents[0]?.uniqueIdentifier).toBe("123-1230984567");
    expect(order.paymentStatus?.awaitingPayment).toBe(false);
  });
});

describe("createPayment", () => {
  it("posts a balance payment for a hold order", async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              id: "pay_123",
              order_id: "ord_123",
              status: "succeeded",
              currency: "USD",
              amount: "299.50",
              type: "balance",
              created_at: "2025-05-01T12:00:00Z",
            },
          }),
        });
      }),
    );
    process.env.DUFFEL_API_KEY = "fake-key";

    const payment = await createPayment({
      orderId: "ord_123",
      amount: "299.50",
      currency: "USD",
    });

    const body = capturedBody as {
      data: {
        order_id: string;
        payment: { amount: string; currency: string; type: string };
      };
    };
    expect(body.data.order_id).toBe("ord_123");
    expect(body.data.payment.type).toBe("balance");
    expect(payment.id).toBe("pay_123");
    expect(payment.status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// Live integration — gated on DUFFEL_API_KEY
// ---------------------------------------------------------------------------

const LIVE_API_KEY = ORIGINAL_ENV.DUFFEL_API_KEY;

describe.skipIf(!LIVE_API_KEY)("searchFlights — live Duffel", () => {
  it("returns at least one offer for JFK → LHR", async () => {
    const request: SearchFlightsRequest = {
      origin: "JFK",
      destination: "LHR",
      departureDate: (() => {
        // Use a date 60 days from now to avoid past-date rejections.
        const d = new Date();
        d.setDate(d.getDate() + 60);
        return d.toISOString().slice(0, 10);
      })(),
      passengers: 1,
    };

    const result = await searchFlights(request, {
      mode: "direct",
      apiKey: LIVE_API_KEY!,
      cloudRelayBaseUrl: null,
    });

    expect(typeof result.offerRequestId).toBe("string");
    expect(result.offers.length).toBeGreaterThan(0);

    const first = result.offers[0];
    expect(typeof first.id).toBe("string");
    expect(typeof first.totalAmount).toBe("string");
    expect(first.slices.length).toBeGreaterThan(0);
  });

  it("can retrieve a single offer by ID", async () => {
    const request: SearchFlightsRequest = {
      origin: "JFK",
      destination: "LHR",
      departureDate: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 60);
        return d.toISOString().slice(0, 10);
      })(),
    };

    const { offers } = await searchFlights(request, {
      mode: "direct",
      apiKey: LIVE_API_KEY!,
      cloudRelayBaseUrl: null,
    });
    expect(offers.length).toBeGreaterThan(0);

    const retrieved = await getOffer(offers[0].id, {
      mode: "direct",
      apiKey: LIVE_API_KEY!,
      cloudRelayBaseUrl: null,
    });
    expect(retrieved.id).toBe(offers[0].id);
    expect(retrieved.totalAmount).toBeDefined();
  });
});
