/**
 * Travel-booking domain for LifeOps: searches flights and prepares/executes
 * flight orders and payments via the Duffel client, then writes the resulting
 * itinerary into the owner's calendar. Booking is a sensitive action gated by
 * owner approval upstream in the action/route layer.
 */
import { ElizaError } from "@elizaos/core";
import {
  createOrder,
  createPayment,
  type DuffelOffer,
  type DuffelOrder,
  type DuffelPayment,
  getOffer,
  getOrder,
  readDuffelConfigFromEnv,
  type SearchFlightsRequest,
  type SearchFlightsResult,
  searchFlights,
} from "@elizaos/plugin-elizacloud/cloud/duffel-client";
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
} from "@elizaos/shared";
import type { LifeOpsContext } from "../lifeops-context.js";
import type {
  ApprovedFlightBookingSnapshot,
  FlightBookingExecutionResult,
  PreparedFlightBooking,
  TravelBookingPassenger,
  TravelCalendarSyncPlan,
} from "../travel-booking.types.js";

// ---------------------------------------------------------------------------
// Capability descriptor
// ---------------------------------------------------------------------------

/**
 * Capability descriptor for the travel connector.
 *
 * inbound:        false   — no inbound messages from travel providers.
 * outbound:       'partial' — flights can be searched and booked; hotel and
 *                             ground transport remain out of scope.
 * search:         true    — flight offer search via Duffel Offer Requests API.
 * identity:       false   — no per-user identity linking.
 * attachments:    false   — no file attachments.
 * deliveryStatus: false   — provider-side delivery receipts do not apply.
 *
 * Scope: flights only. Hotels and car hire are outside this capability.
 */
export const TRAVEL_CAPABILITIES = {
  inbound: false,
  outbound: "partial",
  search: true,
  identity: false,
  attachments: false,
  deliveryStatus: false,
} as const;

export type TravelCapabilities = typeof TRAVEL_CAPABILITIES;

export class TravelPostBookingProjectionError extends Error {
  constructor(
    public readonly booking: FlightBookingExecutionResult,
    cause: unknown,
  ) {
    super(
      `Duffel booking ${booking.order.id} succeeded, but post-booking verification or projection failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "TravelPostBookingProjectionError";
  }
}

export class TravelApprovalDriftError extends ElizaError {
  override readonly name = "TravelApprovalDriftError";

  constructor(message: string) {
    super(message, {
      code: "TRAVEL_APPROVED_QUOTE_CHANGED",
      severity: "ephemeral",
    });
  }
}

function assertApprovedQuoteUnchanged(
  prepared: PreparedFlightBooking,
  approved: ApprovedFlightBookingSnapshot,
): void {
  const currentTotalCents = Math.round(
    Number(prepared.offer.totalAmount) * 100,
  );
  const expiresAt = prepared.offer.expiresAt
    ? Date.parse(prepared.offer.expiresAt)
    : Number.NaN;
  if (
    prepared.offer.id !== approved.offerId ||
    prepared.orderType !== approved.orderType ||
    currentTotalCents !== approved.totalCents ||
    prepared.offer.totalCurrency !== approved.currency ||
    (Number.isFinite(expiresAt) && expiresAt <= Date.now())
  ) {
    throw new TravelApprovalDriftError(
      "Duffel offer changed after approval; refusing to create an order until the owner approves a fresh quote",
    );
  }
}

function assertOrderMatchesApprovedBooking(args: {
  order: DuffelOrder;
  offer: DuffelOffer;
  passengers: ReadonlyArray<TravelBookingPassenger>;
  orderType: "hold" | "instant";
}): void {
  const orderTotalCents = Math.round(Number(args.order.totalAmount) * 100);
  const offerTotalCents = Math.round(Number(args.offer.totalAmount) * 100);
  const passengerMatches = args.passengers.every((passenger, index) => {
    const observed = args.order.passengers[index];
    return (
      observed?.id === resolveOfferPassengerId(args.offer, passenger, index) &&
      observed.givenName === passenger.givenName.trim() &&
      observed.familyName === passenger.familyName.trim()
    );
  });
  const itineraryMatches = args.offer.slices.every((slice, sliceIndex) => {
    const observedSlice = args.order.slices[sliceIndex];
    return (
      observedSlice?.origin === slice.origin &&
      observedSlice.destination === slice.destination &&
      slice.segments.every((segment, segmentIndex) => {
        const observedSegment = observedSlice.segments[segmentIndex];
        return (
          observedSegment?.origin === segment.origin &&
          observedSegment.destination === segment.destination &&
          observedSegment.departingAt === segment.departingAt &&
          observedSegment.arrivingAt === segment.arrivingAt &&
          observedSegment.carrierIataCode === segment.carrierIataCode &&
          observedSegment.flightNumber === segment.flightNumber
        );
      })
    );
  });
  const paymentStateMatches =
    args.orderType === "hold"
      ? args.order.paymentStatus?.awaitingPayment === true
      : args.order.paymentStatus?.awaitingPayment !== true;
  if (
    orderTotalCents !== offerTotalCents ||
    args.order.totalCurrency !== args.offer.totalCurrency ||
    args.order.passengers.length !== args.passengers.length ||
    !passengerMatches ||
    args.order.slices.length !== args.offer.slices.length ||
    !itineraryMatches ||
    !paymentStateMatches
  ) {
    throw new Error(
      "Duffel order readback did not match the approved quote, passengers, itinerary, or payment state",
    );
  }
}

// ---------------------------------------------------------------------------
// Connector status type
// ---------------------------------------------------------------------------

export interface TravelConnectorStatus {
  provider: "travel";
  connected: boolean;
  adapter: "duffel" | null;
  /** "cloud" when routing through Eliza Cloud relay (default), "direct"
   *  when ELIZA_DUFFEL_DIRECT=1 + DUFFEL_API_KEY are set. null when the
   *  travel connector is unconfigured. */
  mode: "cloud" | "direct" | null;
  lastCheckedAt: string;
}

/**
 * Cross-domain dependencies the travel domain needs that do NOT live on
 * {@link LifeOpsContext}. `createCalendarEvent` is owned by the calendar domain
 * (`withCalendar`); travel uses it to sync booked itineraries onto the
 * calendar, so it is injected as a typed callback rather than read off `this`.
 */
export type TravelDeps = {
  createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarEvent>;
};

function choosePreparedOrderType(offer: DuffelOffer): "hold" | "instant" {
  return offer.paymentRequirements?.requiresInstantPayment === false
    ? "hold"
    : "instant";
}

function normalizePassengerValue(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveOfferPassengerId(
  offer: DuffelOffer,
  passenger: TravelBookingPassenger,
  index: number,
): string {
  const explicit = normalizePassengerValue(passenger.offerPassengerId);
  if (explicit) {
    return explicit;
  }
  const fallback = offer.passengers[index]?.id?.trim();
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `Travel booking requires an offer passenger id for passenger ${index + 1}`,
  );
}

function buildItinerarySummary(offer: DuffelOffer): string {
  const firstSlice = offer.slices[0];
  const lastSlice = offer.slices[offer.slices.length - 1];
  if (!firstSlice || !lastSlice) {
    return "Flight itinerary";
  }
  return `${firstSlice.origin} -> ${lastSlice.destination}`;
}

function buildCalendarTitle(
  offer: DuffelOffer,
  order: DuffelOrder,
  calendarSync: TravelCalendarSyncPlan | null | undefined,
): string {
  const custom = calendarSync?.title?.trim();
  if (custom) {
    return custom;
  }
  const route = buildItinerarySummary(offer);
  return order.bookingReference
    ? `Flight ${route} (${order.bookingReference})`
    : `Flight ${route}`;
}

function buildCalendarDescription(
  offer: DuffelOffer,
  order: DuffelOrder,
  payment: DuffelPayment | null,
  calendarSync: TravelCalendarSyncPlan | null | undefined,
): string {
  const parts: string[] = [];
  const custom = calendarSync?.description?.trim();
  if (custom) {
    parts.push(custom);
  }
  if (order.bookingReference) {
    parts.push(`Booking reference: ${order.bookingReference}`);
  }
  parts.push(`Order id: ${order.id}`);
  parts.push(`Total: ${order.totalAmount} ${order.totalCurrency}`);
  if (payment?.id) {
    parts.push(`Payment id: ${payment.id}`);
  }
  const documentIds = order.documents
    .map((document) => document.uniqueIdentifier)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  if (documentIds.length > 0) {
    parts.push(`Documents: ${documentIds.join(", ")}`);
  }
  const carriers = offer.slices
    .flatMap((slice) =>
      slice.segments.map((segment) => segment.carrierIataCode),
    )
    .filter((value, index, values) => value && values.indexOf(value) === index);
  if (carriers.length > 0) {
    parts.push(`Carriers: ${carriers.join(", ")}`);
  }
  return parts.join("\n");
}

function buildCalendarLocation(
  offer: DuffelOffer,
  calendarSync: TravelCalendarSyncPlan | null | undefined,
): string {
  const custom = calendarSync?.location?.trim();
  if (custom) {
    return custom;
  }
  const firstSlice = offer.slices[0];
  const lastSlice = offer.slices[offer.slices.length - 1];
  if (!firstSlice || !lastSlice) {
    return "";
  }
  return `${firstSlice.origin} -> ${lastSlice.destination}`;
}

function firstDepartureAt(order: DuffelOrder): string {
  const segment = order.slices[0]?.segments[0];
  if (!segment) {
    throw new Error("Booked flight order has no departure segment");
  }
  return segment.departingAt;
}

function finalArrivalAt(order: DuffelOrder): string {
  const lastSlice = order.slices[order.slices.length - 1];
  const segment = lastSlice?.segments[lastSlice.segments.length - 1];
  if (!segment) {
    throw new Error("Booked flight order has no arrival segment");
  }
  return segment.arrivingAt;
}

/**
 * Travel domain sub-service: Duffel flight search, offer retrieval, order
 * creation, payment, and end-to-end itinerary booking with optional calendar
 * sync. Depends on the calendar domain's `createCalendarEvent` (injected).
 */
export class TravelDomain {
  constructor(
    readonly _ctx: LifeOpsContext,
    private readonly deps: TravelDeps,
  ) {}

  getTravelConnectorStatus(): TravelConnectorStatus {
    try {
      const config = readDuffelConfigFromEnv();
      return {
        provider: "travel",
        connected: true,
        adapter: "duffel",
        mode: config.mode,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch {
      return {
        provider: "travel",
        connected: false,
        adapter: null,
        mode: null,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  async searchFlights(
    request: SearchFlightsRequest,
  ): Promise<SearchFlightsResult> {
    const config = readDuffelConfigFromEnv();
    return searchFlights(request, config);
  }

  async getFlightOffer(offerId: string): Promise<DuffelOffer> {
    const config = readDuffelConfigFromEnv();
    return getOffer(offerId, config);
  }

  async prepareFlightBooking(args: {
    offerId?: string | null;
    search?: SearchFlightsRequest | null;
    passengers: ReadonlyArray<TravelBookingPassenger>;
    calendarSync?: TravelCalendarSyncPlan | null;
  }): Promise<PreparedFlightBooking> {
    if (args.passengers.length === 0) {
      throw new Error("Travel booking requires at least one passenger");
    }

    let offer: DuffelOffer;
    let offerRequestId: string | null = null;

    if (args.offerId?.trim()) {
      offer = await this.getFlightOffer(args.offerId.trim());
    } else if (args.search) {
      const result = await this.searchFlights(args.search);
      const selectedOffer = result.offers[0];
      if (!selectedOffer) {
        throw new Error(
          "Duffel returned no offers for the requested itinerary",
        );
      }
      offer = await this.getFlightOffer(selectedOffer.id);
      offerRequestId = result.offerRequestId;
    } else {
      throw new Error(
        "Travel booking requires an offer id or a search request",
      );
    }

    return {
      offer,
      orderType: choosePreparedOrderType(offer),
      payload: {
        kind: "flight",
        provider: "duffel",
        itineraryRef: offer.id,
        totalCents: Math.round(Number(offer.totalAmount) * 100),
        currency: offer.totalCurrency,
        offerId: offer.id,
        offerRequestId,
        orderType: choosePreparedOrderType(offer),
        search: args.search ?? null,
        passengers: [...args.passengers],
        calendarSync: args.calendarSync ?? {
          enabled: true,
          calendarId: "primary",
          title: null,
          description: null,
          location: null,
          timeZone: null,
        },
        summary: buildItinerarySummary(offer),
      },
    };
  }

  async createFlightOrder(args: {
    offer: DuffelOffer;
    passengers: ReadonlyArray<TravelBookingPassenger>;
    orderType: "hold" | "instant";
    providerIdempotencyKey: string;
  }): Promise<DuffelOrder> {
    const config = readDuffelConfigFromEnv();
    return createOrder(
      {
        selectedOffers: [args.offer.id],
        type: args.orderType,
        passengers: args.passengers.map((passenger, index) => ({
          id: resolveOfferPassengerId(args.offer, passenger, index),
          title: normalizePassengerValue(passenger.title) ?? undefined,
          gender: normalizePassengerValue(passenger.gender) ?? undefined,
          givenName: passenger.givenName.trim(),
          familyName: passenger.familyName.trim(),
          bornOn: passenger.bornOn.trim(),
          email: normalizePassengerValue(passenger.email) ?? undefined,
          phoneNumber:
            normalizePassengerValue(passenger.phoneNumber) ?? undefined,
        })),
        payment:
          args.orderType === "instant"
            ? {
                type: "balance",
                amount: args.offer.totalAmount,
                currency: args.offer.totalCurrency,
              }
            : undefined,
        metadata: {
          eliza_approval_key: args.providerIdempotencyKey,
        },
      },
      config,
    );
  }

  async getTravelOrder(orderId: string): Promise<DuffelOrder> {
    const config = readDuffelConfigFromEnv();
    return getOrder(orderId, config);
  }

  async payTravelOrder(args: {
    orderId: string;
    amount: string;
    currency: string;
  }): Promise<DuffelPayment> {
    const config = readDuffelConfigFromEnv();
    return createPayment(args, config);
  }

  async bookFlightItinerary(
    requestUrl: URL,
    args: {
      offerId?: string | null;
      search?: SearchFlightsRequest | null;
      passengers: ReadonlyArray<TravelBookingPassenger>;
      calendarSync?: TravelCalendarSyncPlan | null;
      calendarGrantId?: string;
      approved: ApprovedFlightBookingSnapshot;
      providerIdempotencyKey: string;
    },
  ): Promise<FlightBookingExecutionResult> {
    const prepared = await this.prepareFlightBooking(args);
    assertApprovedQuoteUnchanged(prepared, args.approved);
    const order = await this.createFlightOrder({
      offer: prepared.offer,
      passengers: args.passengers,
      orderType: prepared.orderType,
      providerIdempotencyKey: args.providerIdempotencyKey,
    });

    let refreshedOrder = order;
    const payment: DuffelPayment | null = null;
    try {
      refreshedOrder = await this.getTravelOrder(order.id);
      assertOrderMatchesApprovedBooking({
        order: refreshedOrder,
        offer: prepared.offer,
        passengers: args.passengers,
        orderType: prepared.orderType,
      });
    } catch (cause) {
      throw new TravelPostBookingProjectionError(
        {
          offer: prepared.offer,
          order,
          orderType: prepared.orderType,
          paymentCommitted: prepared.orderType === "instant",
          payment,
          calendarEvent: null,
        },
        cause,
      );
    }

    let calendarEvent: Awaited<
      ReturnType<TravelDeps["createCalendarEvent"]>
    > | null = null;
    const calendarSync = args.calendarSync ?? null;
    if (prepared.orderType === "instant" && calendarSync?.enabled !== false) {
      try {
        calendarEvent = await this.deps.createCalendarEvent(requestUrl, {
          mode: "local",
          side: "owner",
          grantId: args.calendarGrantId,
          calendarId: calendarSync?.calendarId ?? "primary",
          title: buildCalendarTitle(
            prepared.offer,
            refreshedOrder,
            calendarSync,
          ),
          description: buildCalendarDescription(
            prepared.offer,
            refreshedOrder,
            payment,
            calendarSync,
          ),
          location: buildCalendarLocation(prepared.offer, calendarSync),
          startAt: firstDepartureAt(refreshedOrder),
          endAt: finalArrivalAt(refreshedOrder),
          timeZone: calendarSync?.timeZone ?? undefined,
        });
      } catch (cause) {
        // error-policy:J2 The order cannot be retried after a projection
        // failure; carry its receipt to the approval reconciliation boundary.
        throw new TravelPostBookingProjectionError(
          {
            offer: prepared.offer,
            order: refreshedOrder,
            orderType: prepared.orderType,
            paymentCommitted: prepared.orderType === "instant",
            payment,
            calendarEvent: null,
          },
          cause,
        );
      }
    }

    return {
      offer: prepared.offer,
      order: refreshedOrder,
      orderType: prepared.orderType,
      paymentCommitted: prepared.orderType === "instant",
      payment,
      calendarEvent,
    };
  }
}
