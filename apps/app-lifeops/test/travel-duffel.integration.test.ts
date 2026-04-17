/**
 * Integration tests for the Duffel flight search adapter.
 *
 * Live tests are gated on DUFFEL_API_KEY being set. When the env var is absent
 * the suite skips — consistent with the credential-gated pattern used across
 * this test directory.
 *
 * Unit-level tests (config parsing, error paths, response mapping) always run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DuffelConfigError,
  readDuffelConfigFromEnv,
  searchFlights,
  getOffer,
  type SearchFlightsRequest,
  type DuffelOffer,
} from "../src/lifeops/travel-adapters/duffel.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.DUFFEL_API_KEY;
});

afterEach(() => {
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config parsing — always runs
// ---------------------------------------------------------------------------

describe("readDuffelConfigFromEnv", () => {
  it("throws DuffelConfigError when DUFFEL_API_KEY is absent", () => {
    expect(() => readDuffelConfigFromEnv()).toThrow(DuffelConfigError);
    expect(() => readDuffelConfigFromEnv()).toThrow(/DUFFEL_API_KEY/);
  });

  it("returns config with apiKey when env var is set", () => {
    process.env.DUFFEL_API_KEY = "duffel_live_test_key";
    const config = readDuffelConfigFromEnv();
    expect(config.apiKey).toBe("duffel_live_test_key");
  });

  it("trims whitespace from apiKey", () => {
    process.env.DUFFEL_API_KEY = "  duffel_key_trimmed  ";
    const config = readDuffelConfigFromEnv();
    expect(config.apiKey).toBe("duffel_key_trimmed");
  });
});

// ---------------------------------------------------------------------------
// searchFlights error paths — always runs (no network)
// ---------------------------------------------------------------------------

describe("searchFlights — config error", () => {
  it("throws DuffelConfigError when no config passed and env is empty", async () => {
    await expect(
      searchFlights({ origin: "JFK", destination: "LHR", departureDate: "2025-06-01" }),
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
      searchFlights({ origin: "JFK", destination: "LHR", departureDate: "2025-06-01" }),
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
      searchFlights({ origin: "JFK", destination: "LHR", departureDate: "2025-06-01" }),
    ).rejects.toThrow("401");
  });

  it("maps Duffel offer response fields correctly", async () => {
    const fakeOffer = {
      id: "off_0000Amvq55bMKivq1xTjJD",
      total_amount: "299.50",
      total_currency: "USD",
      expires_at: "2025-05-01T12:00:00Z",
      passengers: [{ type: "adult" }],
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
// No booking method — always runs
// ---------------------------------------------------------------------------

describe("booking guard", () => {
  it("has no bookFlight or createOrder export", async () => {
    const mod = await import("../src/lifeops/travel-adapters/duffel.js");
    expect((mod as Record<string, unknown>).bookFlight).toBeUndefined();
    expect((mod as Record<string, unknown>).createOrder).toBeUndefined();
    expect((mod as Record<string, unknown>).createOffer).toBeUndefined();
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

    const result = await searchFlights(request, { apiKey: LIVE_API_KEY! });

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

    const { offers } = await searchFlights(request, { apiKey: LIVE_API_KEY! });
    expect(offers.length).toBeGreaterThan(0);

    const retrieved = await getOffer(offers[0].id, { apiKey: LIVE_API_KEY! });
    expect(retrieved.id).toBe(offers[0].id);
    expect(retrieved.totalAmount).toBeDefined();
  });
});
