import { logger } from "@elizaos/core";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics";

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

export interface DuffelOfferPassenger {
  id: string;
  type: string;
  givenName: string | null;
  familyName: string | null;
}

export interface DuffelPaymentRequirements {
  requiresInstantPayment: boolean;
  priceGuaranteeExpiresAt: string | null;
  paymentRequiredBy: string | null;
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
  passengers: DuffelOfferPassenger[];
  paymentRequirements: DuffelPaymentRequirements | null;
}

export interface SearchFlightsResult {
  offerRequestId: string;
  offers: DuffelOffer[];
}

export interface DuffelOrderPassenger {
  id: string;
  givenName: string | null;
  familyName: string | null;
}

export interface DuffelOrderPaymentStatus {
  awaitingPayment: boolean;
  paymentRequiredBy: string | null;
  priceGuaranteeExpiresAt: string | null;
}

export interface DuffelOrderDocument {
  type: string | null;
  uniqueIdentifier: string | null;
}

export interface DuffelOrder {
  id: string;
  bookingReference: string | null;
  totalAmount: string;
  totalCurrency: string;
  slices: DuffelSlice[];
  passengers: DuffelOrderPassenger[];
  paymentStatus: DuffelOrderPaymentStatus | null;
  documents: DuffelOrderDocument[];
}

export interface DuffelPayment {
  id: string;
  orderId: string;
  status: string;
  currency: string;
  amount: string;
  type: string;
  failureReason: string | null;
  createdAt: string | null;
}

export interface DuffelOrderPassengerInput {
  id: string;
  title?: string;
  gender?: string;
  givenName: string;
  familyName: string;
  bornOn: string;
  email?: string;
  phoneNumber?: string;
}

export interface CreateDuffelOrderRequest {
  selectedOffers: ReadonlyArray<string>;
  passengers: ReadonlyArray<DuffelOrderPassengerInput>;
  type: "hold" | "instant";
  payment?: {
    type: "balance";
    amount: string;
    currency: string;
  };
  metadata?: Readonly<Record<string, string>>;
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
  passengers: Array<{
    id?: string;
    type?: string;
    given_name?: string | null;
    family_name?: string | null;
  }>;
  payment_requirements?: {
    requires_instant_payment?: boolean;
    price_guarantee_expires_at?: string | null;
    payment_required_by?: string | null;
  };
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

interface DuffelApiOrder {
  id: string;
  booking_reference?: string | null;
  total_amount: string;
  total_currency: string;
  slices: DuffelApiOffer["slices"];
  passengers: Array<{
    id?: string;
    given_name?: string | null;
    family_name?: string | null;
  }>;
  payment_status?: {
    awaiting_payment?: boolean;
    payment_required_by?: string | null;
    price_guarantee_expires_at?: string | null;
  };
  documents?: Array<{
    type?: string | null;
    unique_identifier?: string | null;
  }>;
}

interface DuffelOrderResponse {
  data: DuffelApiOrder;
}

interface DuffelPaymentResponse {
  data: {
    id: string;
    order_id: string;
    status: string;
    currency: string;
    amount: string;
    type: string;
    failure_reason?: string | null;
    created_at?: string | null;
  };
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
  const cabinClass = raw.slices[0]?.fare_brand_name ?? null;

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
  const passengers: DuffelOfferPassenger[] = (raw.passengers ?? []).map(
    (passenger, index) => ({
      id: passenger.id?.trim() || `passenger_${index}`,
      type: passenger.type?.trim() || "adult",
      givenName: passenger.given_name?.trim() || null,
      familyName: passenger.family_name?.trim() || null,
    }),
  );
  const paymentRequirements = raw.payment_requirements
    ? {
        requiresInstantPayment:
          raw.payment_requirements.requires_instant_payment !== false,
        priceGuaranteeExpiresAt:
          raw.payment_requirements.price_guarantee_expires_at ?? null,
        paymentRequiredBy: raw.payment_requirements.payment_required_by ?? null,
      }
    : null;

  return {
    id: raw.id,
    totalAmount: raw.total_amount,
    totalCurrency: raw.total_currency,
    passengerCount: passengers.length > 0 ? passengers.length : 1,
    slices,
    expiresAt: raw.expires_at,
    cabinClass,
    passengers,
    paymentRequirements,
  };
}

function mapOrder(raw: DuffelApiOrder): DuffelOrder {
  return {
    id: raw.id,
    bookingReference: raw.booking_reference ?? null,
    totalAmount: raw.total_amount,
    totalCurrency: raw.total_currency,
    slices: raw.slices.map((slice) => ({
      origin: slice.origin.iata_code,
      destination: slice.destination.iata_code,
      duration: slice.duration,
      segments: slice.segments.map((segment) => ({
        origin: segment.origin.iata_code,
        destination: segment.destination.iata_code,
        departingAt: segment.departing_at,
        arrivingAt: segment.arriving_at,
        carrierIataCode: segment.operating_carrier.iata_code,
        flightNumber: segment.flight_number ?? "",
        duration: segment.duration,
      })),
    })),
    passengers: (raw.passengers ?? []).map((passenger, index) => ({
      id: passenger.id?.trim() || `passenger_${index}`,
      givenName: passenger.given_name?.trim() || null,
      familyName: passenger.family_name?.trim() || null,
    })),
    paymentStatus: raw.payment_status
      ? {
          awaitingPayment: raw.payment_status.awaiting_payment === true,
          paymentRequiredBy: raw.payment_status.payment_required_by ?? null,
          priceGuaranteeExpiresAt:
            raw.payment_status.price_guarantee_expires_at ?? null,
        }
      : null,
    documents: (raw.documents ?? []).map((document) => ({
      type: document.type ?? null,
      uniqueIdentifier: document.unique_identifier ?? null,
    })),
  };
}

function mapPayment(
  raw: DuffelPaymentResponse["data"],
): DuffelPayment {
  return {
    id: raw.id,
    orderId: raw.order_id,
    status: raw.status,
    currency: raw.currency,
    amount: raw.amount,
    type: raw.type,
    failureReason: raw.failure_reason ?? null,
    createdAt: raw.created_at ?? null,
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Search for available flight offers via the Duffel Offer Requests API.
 *
 * Throws `DuffelConfigError` when DUFFEL_API_KEY is absent.
 * One-way search when `returnDate` is omitted; return search when provided.
 *
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

export async function createOrder(
  request: CreateDuffelOrderRequest,
  config?: DuffelConfig,
): Promise<DuffelOrder> {
  const resolvedConfig = config ?? readDuffelConfigFromEnv();
  if (request.selectedOffers.length !== 1) {
    throw new Error("Duffel createOrder: exactly one selected offer is required");
  }
  if (request.passengers.length === 0) {
    throw new Error("Duffel createOrder: at least one passenger is required");
  }

  const data: Record<string, unknown> = {
    type: request.type,
    selected_offers: [...request.selectedOffers],
    passengers: request.passengers.map((passenger) => ({
      id: passenger.id,
      title: passenger.title,
      gender: passenger.gender,
      given_name: passenger.givenName,
      family_name: passenger.familyName,
      born_on: passenger.bornOn,
      email: passenger.email,
      phone_number: passenger.phoneNumber,
    })),
  };
  if (request.payment) {
    data.payments = [
      {
        type: request.payment.type,
        amount: request.payment.amount,
        currency: request.payment.currency,
      },
    ];
  }
  if (request.metadata && Object.keys(request.metadata).length > 0) {
    data.metadata = request.metadata;
  }

  const response = await duffelFetch<DuffelOrderResponse>({
    apiKey: resolvedConfig.apiKey,
    method: "POST",
    path: "/air/orders",
    body: { data },
    operation: "order_create",
  });

  return mapOrder(response.data);
}

export async function getOrder(
  orderId: string,
  config?: DuffelConfig,
): Promise<DuffelOrder> {
  const resolvedConfig = config ?? readDuffelConfigFromEnv();
  if (!orderId || orderId.trim().length === 0) {
    throw new Error("Duffel getOrder: order id is required");
  }

  const response = await duffelFetch<DuffelOrderResponse>({
    apiKey: resolvedConfig.apiKey,
    method: "GET",
    path: `/air/orders/${encodeURIComponent(orderId.trim())}`,
    operation: "order_retrieve",
  });

  return mapOrder(response.data);
}

export async function createPayment(
  args: {
    orderId: string;
    amount: string;
    currency: string;
  },
  config?: DuffelConfig,
): Promise<DuffelPayment> {
  const resolvedConfig = config ?? readDuffelConfigFromEnv();
  if (!args.orderId || args.orderId.trim().length === 0) {
    throw new Error("Duffel createPayment: order id is required");
  }
  if (!args.amount || args.amount.trim().length === 0) {
    throw new Error("Duffel createPayment: amount is required");
  }
  if (!args.currency || args.currency.trim().length === 0) {
    throw new Error("Duffel createPayment: currency is required");
  }

  const response = await duffelFetch<DuffelPaymentResponse>({
    apiKey: resolvedConfig.apiKey,
    method: "POST",
    path: "/air/payments",
    body: {
      data: {
        order_id: args.orderId.trim(),
        payment: {
          type: "balance",
          amount: args.amount.trim(),
          currency: args.currency.trim().toUpperCase(),
        },
      },
    },
    operation: "payment_create",
  });

  return mapPayment(response.data);
}
