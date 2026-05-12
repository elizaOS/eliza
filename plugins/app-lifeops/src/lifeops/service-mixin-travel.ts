// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
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
} from "./travel-adapters/duffel.js";
import type {
  FlightBookingExecutionResult,
  PreparedFlightBooking,
  TravelBookingPassenger,
  TravelCalendarSyncPlan,
} from "./travel-booking.types.js";

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
 * Scope: flights only. Hotels and car hire are deferred to a future iteration.
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

// ---------------------------------------------------------------------------
// Mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withTravel<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsTravelServiceMixin extends Base {
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
      },
    ): Promise<FlightBookingExecutionResult> {
      const prepared = await this.prepareFlightBooking(args);
      const order = await this.createFlightOrder({
        offer: prepared.offer,
        passengers: args.passengers,
        orderType: prepared.orderType,
      });

      let refreshedOrder = order;
      let payment: DuffelPayment | null = null;
      if (
        prepared.orderType === "hold" &&
        refreshedOrder.paymentStatus?.awaitingPayment
      ) {
        refreshedOrder = await this.getTravelOrder(order.id);
        payment = await this.payTravelOrder({
          orderId: refreshedOrder.id,
          amount: refreshedOrder.totalAmount,
          currency: refreshedOrder.totalCurrency,
        });
        refreshedOrder = await this.getTravelOrder(order.id);
      }

      let calendarEvent = null;
      const calendarSync = args.calendarSync ?? null;
      if (calendarSync?.enabled !== false) {
        calendarEvent = await this.createCalendarEvent(requestUrl, {
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
      }

      return {
        offer: prepared.offer,
        order: refreshedOrder,
        payment,
        calendarEvent,
      };
    }
  }

  return LifeOpsTravelServiceMixin;
}
