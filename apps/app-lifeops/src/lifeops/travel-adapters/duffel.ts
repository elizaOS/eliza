import { logger } from "@elizaos/core";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics/integration-observability";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class DuffelConfigError extends Error {
  readonly code = "DUFFEL_NOT_CONFIGURED" as const;
  constructor(message: string) {
    super(message);
    this.name = "DuffelConfigError";
  }
}

export interface DuffelConfig {
  apiKey: string;
}

const DUFFEL_API_BASE = "https://api.duffel.com";
const DUFFEL_API_VERSION = "v2";

export function readDuffelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DuffelConfig {
  const apiKey = env.DUFFEL_API_KEY?.trim();
  if (!apiKey) {
    throw new DuffelConfigError(
      "Duffel travel search is not configured. Set DUFFEL_API_KEY.",
    );
  }
  return { apiKey };
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface SearchFlightsRequest {
  /** IATA airport code for origin, e.g. "JFK". */
  origin: string;
  /** IATA airport code for destination, e.g. "LHR". */
  destination: string;
  /** ISO 8601 date string (YYYY-MM-DD). */
  departureDate: string;
  /**
   * ISO 8601 date string for return leg.
   * Omit or pass undefined for one-way search.
   */
  returnDate?: string;
  /** Number of adult passengers (default 1). */
  passengers?: number;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface DuffelSegment {
  origin: string;
  destination: string;
  departingAt: string;
  arrivingAt: string;
  carrierIataCode: string;
  flightNumber: string;
  duration: string;
}

export interface DuffelSlice {
  origin: string;
  destination: string;
  duration: string;
  segments: DuffelSegment[];
}

export interface DuffelOffer {
  id: string;
  totalAmount: string;
  totalCurrency: string;
  passengerCount: number;
  slices: DuffelSlice[];
  expiresAt: string | null;
  /** Raw cabin class reported by Duffel for the first slice. */
  cabinClass: string | null;
}

export interface SearchFlightsResult {
  offerRequestId: string;
  offers: DuffelOffer[];
}

// ---------------------------------------------------------------------------
// Internal Duffel API response shapes (minimal — only fields we use)
// ---------------------------------------------------------------------------

interface DuffelApiOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at: string | null;
  slices: Array<{
    origin: { iata_code: string };
    destination: { iata_code: string };
    duration: string;
    segments: Array<{
      origin: { iata_code: string };
      destination: { iata_code: string };
      departing_at: string;
      arriving_at: string;
      operating_carrier: { iata_code: string };
      flight_number: string | null;
      duration: string;
    }>;
    fare_brand_name: string | null;
  }>;
  passengers: unknown[];
}

interface DuffelOfferRequestResponse {
  data: {
    id: string;
    offers: DuffelApiOffer[];
  };
}

interface DuffelOfferResponse {
  data: DuffelApiOffer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Duffel-Version": DUFFEL_API_VERSION,
    Accept: "application/json",
  };
}

function mapOffer(raw: DuffelApiOffer): DuffelOffer {
  const cabinClass =
    raw.slices[0]?.fare_brand_name ?? null;

  const slices: DuffelSlice[] = raw.slices.map((slice) => ({
    origin: slice.origin.iata_code,
    destination: slice.destination.iata_code,
    duration: slice.duration,
    segments: slice.segments.map((seg) => ({
      origin: seg.origin.iata_code,
      destination: seg.destination.iata_code,
      departingAt: seg.departing_at,
      arrivingAt: seg.arriving_at,
      carrierIataCode: seg.operating_carrier.iata_code,
      flightNumber: seg.flight_number ?? "",
      duration: seg.duration,
    })),
  }));

  return {
    id: raw.id,
    totalAmount: raw.total_amount,
    totalCurrency: raw.total_currency,
    passengerCount: Array.isArray(raw.passengers) ? raw.passengers.length : 1,
    slices,
    expiresAt: raw.expires_at,
    cabinClass,
  };
}

async function duffelFetch<T>(args: {
  apiKey: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  operation: string;
}): Promise<T> {
  const { apiKey, method, path, body, operation } = args;
  const url = `${DUFFEL_API_BASE}${path}`;

  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation,
    timeoutMs: 30_000,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: buildHeaders(apiKey),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      { boundary: "lifeops", integration: "duffel", operation, err: error instanceof Error ? error : undefined },
      `[lifeops-travel] Duffel ${operation} network error: ${msg}`,
    );
    span.failure({ error, errorKind: "network_error" });
    throw new Error(`Duffel ${operation} failed: ${msg}`);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const errorMsg = errorBody || `HTTP ${response.status}`;
    logger.warn(
      { boundary: "lifeops", integration: "duffel", operation, statusCode: response.status },
      `[lifeops-travel] Duffel ${operation} HTTP error: ${errorMsg}`,
    );
    span.failure({ statusCode: response.status, errorKind: "http_error" });
    throw new Error(`Duffel ${operation} failed (${response.status}): ${errorMsg}`);
  }

  const data = (await response.json()) as T;
  span.success({ statusCode: response.status });
  return data;
}

// ---------------------------------------------------------------------------
// Public API — read-only search. No booking method.
// ---------------------------------------------------------------------------

/**
 * Search for available flight offers via the Duffel Offer Requests API.
 *
 * Throws `DuffelConfigError` when DUFFEL_API_KEY is absent.
 * One-way search when `returnDate` is omitted; return search when provided.
 *
 * NOTE: This is read-only. Booking (offer order creation) is intentionally
 * absent from this adapter — it requires a separate user-approval flow (WS6).
 */
export async function searchFlights(
  request: SearchFlightsRequest,
  config?: DuffelConfig,
): Promise<SearchFlightsResult> {
  const resolvedConfig = config ?? readDuffelConfigFromEnv();
  const passengerCount = Math.max(1, Math.round(request.passengers ?? 1));

  const slices: Array<{ origin: string; destination: string; departure_date: string }> = [
    {
      origin: request.origin.toUpperCase().trim(),
      destination: request.destination.toUpperCase().trim(),
      departure_date: request.departureDate,
    },
  ];
  if (request.returnDate) {
    slices.push({
      origin: request.destination.toUpperCase().trim(),
      destination: request.origin.toUpperCase().trim(),
      departure_date: request.returnDate,
    });
  }

  const requestBody = {
    data: {
      slices,
      passengers: Array.from({ length: passengerCount }, () => ({ type: "adult" })),
      cabin_class: "economy",
    },
  };

  logger.info(
    { boundary: "lifeops", integration: "duffel", origin: request.origin, destination: request.destination },
    `[lifeops-travel] Searching flights ${request.origin} → ${request.destination} on ${request.departureDate}`,
  );

  const responseData = await duffelFetch<DuffelOfferRequestResponse>({
    apiKey: resolvedConfig.apiKey,
    method: "POST",
    path: "/air/offer_requests?return_offers=true",
    body: requestBody,
    operation: "offer_request",
  });

  const offers = (responseData.data.offers ?? []).map(mapOffer);

  logger.info(
    { boundary: "lifeops", integration: "duffel", offerRequestId: responseData.data.id, offerCount: offers.length },
    `[lifeops-travel] Duffel returned ${offers.length} offers for request ${responseData.data.id}`,
  );

  return {
    offerRequestId: responseData.data.id,
    offers,
  };
}

/**
 * Retrieve a single flight offer by ID.
 *
 * Use after `searchFlights` to get live pricing and full details for a
 * specific offer before presenting it to the user for approval.
 *
 * NOTE: This is read-only. Booking requires a separate approval flow (WS6).
 */
export async function getOffer(
  id: string,
  config?: DuffelConfig,
): Promise<DuffelOffer> {
  const resolvedConfig = config ?? readDuffelConfigFromEnv();

  if (!id || id.trim().length === 0) {
    throw new Error("Duffel getOffer: offer id is required");
  }

  const responseData = await duffelFetch<DuffelOfferResponse>({
    apiKey: resolvedConfig.apiKey,
    method: "GET",
    path: `/air/offers/${encodeURIComponent(id.trim())}`,
    operation: "offer_retrieve",
  });

  return mapOffer(responseData.data);
}
