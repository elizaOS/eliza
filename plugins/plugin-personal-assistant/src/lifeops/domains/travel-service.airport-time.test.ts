/**
 * Duffel gives segment times as local airport time without an offset, and
 * each airport carries its IANA `time_zone`. The booked flight goes on the
 * calendar at the real instants: departure in the origin zone, arrival in the
 * destination zone. Real TravelDomain and Duffel client; Duffel's HTTP API is
 * replayed with the documented shapes.
 */
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
} from "@elizaos/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import { TravelDomain } from "./travel-service.js";

// Tokyo 21:00 on Nov 1 to Honolulu 09:00 on Nov 1: crosses the date line.
const slices = [
  {
    origin: { iata_code: "HND", time_zone: "Asia/Tokyo" },
    destination: { iata_code: "HNL", time_zone: "Pacific/Honolulu" },
    duration: "PT7H",
    fare_brand_name: "Economy",
    segments: [
      {
        origin: { iata_code: "HND", time_zone: "Asia/Tokyo" },
        destination: { iata_code: "HNL", time_zone: "Pacific/Honolulu" },
        departing_at: "2026-11-01T21:00:00",
        arriving_at: "2026-11-01T09:00:00",
        operating_carrier: { iata_code: "NH" },
        flight_number: "NH186",
        duration: "PT7H",
      },
    ],
  },
];

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.DUFFEL_API_KEY = "duffel-test-key";
  process.env.ELIZA_DUFFEL_DIRECT = "1";
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/air/offers/")) {
      return json({
        id: "off_hnd_hnl",
        total_amount: "820.00",
        total_currency: "USD",
        expires_at: "2026-10-30T00:00:00Z",
        passengers: [{ id: "pas_1", type: "adult" }],
        payment_requirements: { requires_instant_payment: true },
        slices,
      });
    }
    if (url.endsWith("/air/orders")) {
      return json({
        id: "ord_hnd_hnl",
        booking_reference: "ABC123",
        total_amount: "820.00",
        total_currency: "USD",
        slices,
        passengers: [
          { id: "pas_1", given_name: "Ada", family_name: "Lovelace" },
        ],
        payment_status: { awaiting_payment: false },
      });
    }
    throw new Error(`unexpected Duffel request: ${url}`);
  });
});

afterEach(() => {
  delete process.env.DUFFEL_API_KEY;
  delete process.env.ELIZA_DUFFEL_DIRECT;
  vi.unstubAllGlobals();
});

it("puts a booked flight on the calendar at its real departure and arrival", async () => {
  const created: CreateLifeOpsCalendarEventRequest[] = [];
  const travel = new TravelDomain({} as LifeOpsContext, {
    createCalendarEvent: async (_url, request) => {
      created.push(request);
      return { id: "evt-1" } as LifeOpsCalendarEvent;
    },
  });

  await travel.bookFlightItinerary(new URL("http://127.0.0.1/"), {
    offerId: "off_hnd_hnl",
    passengers: [
      {
        givenName: "Ada",
        familyName: "Lovelace",
        bornOn: "1990-01-01",
      },
    ],
  });

  expect(created).toHaveLength(1);
  // 21:00 in Tokyo is 12:00 UTC; 09:00 in Honolulu is 19:00 UTC.
  expect(created[0]?.startAt).toBe("2026-11-01T12:00:00.000Z");
  expect(created[0]?.endAt).toBe("2026-11-01T19:00:00.000Z");
});
