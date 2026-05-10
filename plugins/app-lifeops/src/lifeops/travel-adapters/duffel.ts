import { createIntegrationTelemetrySpan } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import {
  PaymentRequiredError,
  parseX402Response,
} from "../x402-payment-handler.js";

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

/** Direct mode hits api.duffel.com with the user's own DUFFEL_API_KEY.
 *  Cloud mode hits the local Eliza Cloud relay which performs the upstream
 *  Duffel call, applies creator markup, and meters against the user's
 *  Cloud credit balance. Cloud mode is the default. */
export type DuffelMode = "cloud" | "direct";

export interface DuffelConfig {
  mode: DuffelMode;
  /** Required when mode === "direct". */
  apiKey: string | null;
  /** Required when mode === "cloud". Local Eliza agent API base, e.g.
   *  http://127.0.0.1:31337. The relay path is appended internally. */
  cloudRelayBaseUrl: string | null;
}

const DUFFEL_API_BASE_DEFAULT = "https://api.duffel.com";
const DUFFEL_API_VERSION = "v2";
const DEFAULT_CLOUD_RELAY_BASE = "http://127.0.0.1:31337";

/** Honour the mockoon redirect (or any explicit `LIFEOPS_DUFFEL_API_BASE`
 *  override) so direct-mode tests can swap Duffel for a local mock. */
function getDuffelApiBase(): string {
  return process.env.LIFEOPS_DUFFEL_API_BASE?.trim() || DUFFEL_API_BASE_DEFAULT;
}

function resolveDirectFlag(env: NodeJS.ProcessEnv): boolean {
  const value = env.ELIZA_DUFFEL_DIRECT?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function resolveLocalApiBase(env: NodeJS.ProcessEnv): string {
  const port = env.ELIZA_API_PORT?.trim();
  if (port && /^\d+$/.test(port)) {
    return `http://127.0.0.1:${port}`;
  }
  return DEFAULT_CLOUD_RELAY_BASE;
}

export function readDuffelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DuffelConfig {
  if (resolveDirectFlag(env)) {
    const apiKey = env.DUFFEL_API_KEY?.trim();
    if (!apiKey) {
      throw new DuffelConfigError(
        "Duffel direct mode requested but DUFFEL_API_KEY is not set.",
      );
    }
    return { mode: "direct", apiKey, cloudRelayBaseUrl: null };
  }

  return {
    mode: "cloud",
    apiKey: null,
    cloudRelayBaseUrl: resolveLocalApiBase(env),
  };
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

/**
 * Cost envelope returned by the cloud relay. The breakdown is computed
 * server-side (commandment 2 — no client-side math) and the local code
 * forwards it to the UI for display. In direct mode all values are zero
 * because no markup is charged.
 *
 * `markupPercent` is a *display-only* derived field: it equals
 * `platformFeeUsd / totalUsd`, computed once at the boundary so UI
 * components don't repeat the division. The pricing decision itself is
 * still Cloud-side — this is the same pattern as a "discount %" badge
 * derived from a server-supplied price.
 */
export interface DuffelCallCost {
  /** Net cost charged to the user's Cloud credit balance, in USD. */
  totalUsd: number;
  /** Portion that flows to the creator as markup, in USD. */
  creatorMarkupUsd: number;
  /** Eliza Cloud platform fee portion, in USD. */
  platformFeeUsd: number;
  /** Display-only ratio of platform fee to total (e.g. 0.2 for 20%).
   *  Derived from server values, never used for pricing. Null when
   *  totalUsd is zero (direct mode or free call). */
  markupPercent: number | null;
  /** Whether the call was metered (true in cloud mode, false in direct mode). */
  metered: boolean;
}

const DIRECT_MODE_COST: DuffelCallCost = {
  totalUsd: 0,
  creatorMarkupUsd: 0,
  platformFeeUsd: 0,
  markupPercent: null,
  metered: false,
};

export interface SearchFlightsResult {
  offerRequestId: string;
  offers: DuffelOffer[];
  cost: DuffelCallCost;
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

function mapPayment(raw: DuffelPaymentResponse["data"]): DuffelPayment {
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

/**
 * Cost meta envelope returned by the Eliza Cloud relay alongside the
 * Duffel payload. Defined server-side; the client trusts whatever Cloud
 * returns and never recomputes (commandment 2).
 */
interface RelayCostMeta {
  total_usd?: number;
  creator_markup_usd?: number;
  platform_fee_usd?: number;
}

interface RelayMeta {
  cost?: RelayCostMeta;
}

interface RelayEnvelope {
  _meta?: RelayMeta;
}

function readRelayCost(envelope: unknown): DuffelCallCost {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("_meta" in envelope)
  ) {
    throw new Error(
      "Duffel cloud relay response missing _meta envelope. Update Eliza Cloud or set ELIZA_DUFFEL_DIRECT=1.",
    );
  }
  const meta = (envelope as RelayEnvelope)._meta;
  const cost = meta?.cost;
  if (
    !cost ||
    typeof cost.total_usd !== "number" ||
    typeof cost.creator_markup_usd !== "number" ||
    typeof cost.platform_fee_usd !== "number"
  ) {
    throw new Error(
      "Duffel cloud relay returned malformed _meta.cost. Refusing to proceed without billing receipt.",
    );
  }
  const totalUsd = cost.total_usd;
  const platformFeeUsd = cost.platform_fee_usd;
  const markupPercent = totalUsd > 0 ? platformFeeUsd / totalUsd : null;
  return {
    totalUsd,
    creatorMarkupUsd: cost.creator_markup_usd,
    platformFeeUsd,
    markupPercent,
    metered: true,
  };
}

interface DuffelFetchResult<T> {
  data: T;
  cost: DuffelCallCost;
}

interface DuffelRequest {
  config: DuffelConfig;
  method: "GET" | "POST";
  /** Path on api.duffel.com (e.g. "/air/offer_requests"). */
  directPath: string;
  /** Path on the local cloud relay (e.g. "/api/cloud/travel-providers/duffel/offer-requests"). */
  cloudRelayPath: string;
  body?: unknown;
  operation: string;
}

async function duffelFetch<T>(
  args: DuffelRequest,
): Promise<DuffelFetchResult<T>> {
  const { config, method, directPath, cloudRelayPath, body, operation } = args;

  const isCloud = config.mode === "cloud";
  const url = isCloud
    ? `${config.cloudRelayBaseUrl ?? ""}${cloudRelayPath}`
    : `${getDuffelApiBase()}${directPath}`;

  const headers = isCloud
    ? { "Content-Type": "application/json", Accept: "application/json" }
    : buildHeaders(config.apiKey ?? "");

  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation,
    timeoutMs: 30_000,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        boundary: "lifeops",
        integration: "duffel",
        operation,
        mode: config.mode,
        err: error instanceof Error ? error : undefined,
      },
      `[lifeops-travel] Duffel ${operation} network error: ${msg}`,
    );
    span.failure({ error, errorKind: "network_error" });
    throw new Error(`Duffel ${operation} failed: ${msg}`);
  }

  if (response.status === 402 && isCloud) {
    // x402 payment-required: surface as a typed PaymentRequiredError so
    // the action layer can route the user to the wallet top-up flow
    // rather than treating this as a generic HTTP failure. The Cloud
    // billing layer emits 402 only when the user's credit balance can't
    // cover the call — see docs/cloud-travel-billing.md.
    const requirements = await parseX402Response(response);
    logger.warn(
      {
        boundary: "lifeops",
        integration: "duffel",
        operation,
        mode: config.mode,
        statusCode: 402,
        requirementCount: requirements?.length ?? 0,
      },
      `[lifeops-travel] Duffel ${operation} returned 402 payment-required`,
    );
    span.failure({ statusCode: 402, errorKind: "payment_required" });
    if (!requirements || requirements.length === 0) {
      throw new PaymentRequiredError(
        [],
        `Duffel ${operation} requires payment but the upstream did not advertise any payment options.`,
      );
    }
    throw new PaymentRequiredError(requirements);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const errorMsg = errorBody || `HTTP ${response.status}`;
    logger.warn(
      {
        boundary: "lifeops",
        integration: "duffel",
        operation,
        mode: config.mode,
        statusCode: response.status,
      },
      `[lifeops-travel] Duffel ${operation} HTTP error: ${errorMsg}`,
    );
    span.failure({ statusCode: response.status, errorKind: "http_error" });
    throw new Error(
      `Duffel ${operation} failed (${response.status}): ${errorMsg}`,
    );
  }

  const payload = (await response.json()) as T;
  span.success({ statusCode: response.status });

  const cost = isCloud ? readRelayCost(payload) : DIRECT_MODE_COST;
  return { data: payload, cost };
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

  const slices: Array<{
    origin: string;
    destination: string;
    departure_date: string;
  }> = [
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
      passengers: Array.from({ length: passengerCount }, () => ({
        type: "adult",
      })),
      cabin_class: "economy",
    },
  };

  logger.info(
    {
      boundary: "lifeops",
      integration: "duffel",
      origin: request.origin,
      destination: request.destination,
    },
    `[lifeops-travel] Searching flights ${request.origin} → ${request.destination} on ${request.departureDate}`,
  );

  const { data: responseData, cost } =
    await duffelFetch<DuffelOfferRequestResponse>({
      config: resolvedConfig,
      method: "POST",
      directPath: "/air/offer_requests?return_offers=true",
      cloudRelayPath: "/api/cloud/travel-providers/duffel/offer-requests",
      body: requestBody,
      operation: "offer_request",
    });

  const offers = (responseData.data.offers ?? []).map(mapOffer);

  logger.info(
    {
      boundary: "lifeops",
      integration: "duffel",
      offerRequestId: responseData.data.id,
      offerCount: offers.length,
      costUsd: cost.totalUsd,
    },
    `[lifeops-travel] Duffel returned ${offers.length} offers for request ${responseData.data.id}`,
  );

  return {
    offerRequestId: responseData.data.id,
    offers,
    cost,
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

  const { data: responseData } = await duffelFetch<DuffelOfferResponse>({
    config: resolvedConfig,
    method: "GET",
    directPath: `/air/offers/${encodeURIComponent(id.trim())}`,
    cloudRelayPath: `/api/cloud/travel-providers/duffel/offers/${encodeURIComponent(id.trim())}`,
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
    throw new Error(
      "Duffel createOrder: exactly one selected offer is required",
    );
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

  const { data: response } = await duffelFetch<DuffelOrderResponse>({
    config: resolvedConfig,
    method: "POST",
    directPath: "/air/orders",
    cloudRelayPath: "/api/cloud/travel-providers/duffel/orders",
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

  const { data: response } = await duffelFetch<DuffelOrderResponse>({
    config: resolvedConfig,
    method: "GET",
    directPath: `/air/orders/${encodeURIComponent(orderId.trim())}`,
    cloudRelayPath: `/api/cloud/travel-providers/duffel/orders/${encodeURIComponent(orderId.trim())}`,
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
  if (args.orderId.trim().length === 0) {
    throw new Error("Duffel createPayment: order id is required");
  }
  if (args.amount.trim().length === 0) {
    throw new Error("Duffel createPayment: amount is required");
  }
  if (args.currency.trim().length === 0) {
    throw new Error("Duffel createPayment: currency is required");
  }

  const { data: response } = await duffelFetch<DuffelPaymentResponse>({
    config: resolvedConfig,
    method: "POST",
    directPath: "/air/payments",
    cloudRelayPath: "/api/cloud/travel-providers/duffel/payments",
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
