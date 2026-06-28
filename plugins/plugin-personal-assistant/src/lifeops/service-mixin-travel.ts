import type {
  DuffelOffer,
  DuffelOrder,
  DuffelPayment,
  SearchFlightsRequest,
  SearchFlightsResult,
} from "@elizaos/plugin-elizacloud/cloud/duffel-client";
import { type TravelDeps, TravelDomain } from "./domains/travel-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import type {
  FlightBookingExecutionResult,
  PreparedFlightBooking,
  TravelBookingPassenger,
  TravelCalendarSyncPlan,
} from "./travel-booking.types.js";

export {
  TRAVEL_CAPABILITIES,
  type TravelCapabilities,
  type TravelConnectorStatus,
} from "./domains/travel-service.js";

export interface LifeOpsTravelServicePublic {
  getTravelConnectorStatus(): ReturnType<
    TravelDomain["getTravelConnectorStatus"]
  >;
  searchFlights(request: SearchFlightsRequest): Promise<SearchFlightsResult>;
  getFlightOffer(offerId: string): Promise<DuffelOffer>;
  prepareFlightBooking(args: {
    offerId?: string | null;
    search?: SearchFlightsRequest | null;
    passengers: ReadonlyArray<TravelBookingPassenger>;
    calendarSync?: TravelCalendarSyncPlan | null;
  }): Promise<PreparedFlightBooking>;
  createFlightOrder(args: {
    offer: DuffelOffer;
    passengers: ReadonlyArray<TravelBookingPassenger>;
    orderType?: "hold" | "instant";
  }): Promise<DuffelOrder>;
  getTravelOrder(orderId: string): Promise<DuffelOrder>;
  payTravelOrder(args: {
    orderId: string;
    amount: string;
    currency: string;
  }): Promise<DuffelPayment>;
  bookFlightItinerary(
    requestUrl: URL,
    args: {
      offerId?: string | null;
      search?: SearchFlightsRequest | null;
      passengers: ReadonlyArray<TravelBookingPassenger>;
      calendarSync?: TravelCalendarSyncPlan | null;
    },
  ): Promise<FlightBookingExecutionResult>;
}

/** @internal */
export function withTravel<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsTravelServicePublic> {
  class LifeOpsTravelServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly travelDomain = new TravelDomain(this, {
      createCalendarEvent: (...args) =>
        (
          this as unknown as {
            createCalendarEvent(
              ...a: Parameters<TravelDeps["createCalendarEvent"]>
            ): ReturnType<TravelDeps["createCalendarEvent"]>;
          }
        ).createCalendarEvent(...args),
    });

    getTravelConnectorStatus() {
      return this.travelDomain.getTravelConnectorStatus();
    }

    searchFlights(request: SearchFlightsRequest): Promise<SearchFlightsResult> {
      return this.travelDomain.searchFlights(request);
    }

    getFlightOffer(offerId: string): Promise<DuffelOffer> {
      return this.travelDomain.getFlightOffer(offerId);
    }

    prepareFlightBooking(args: {
      offerId?: string | null;
      search?: SearchFlightsRequest | null;
      passengers: ReadonlyArray<TravelBookingPassenger>;
      calendarSync?: TravelCalendarSyncPlan | null;
    }): Promise<PreparedFlightBooking> {
      return this.travelDomain.prepareFlightBooking(args);
    }

    createFlightOrder(args: {
      offer: DuffelOffer;
      passengers: ReadonlyArray<TravelBookingPassenger>;
      orderType: "hold" | "instant";
    }): Promise<DuffelOrder> {
      return this.travelDomain.createFlightOrder(args);
    }

    getTravelOrder(orderId: string): Promise<DuffelOrder> {
      return this.travelDomain.getTravelOrder(orderId);
    }

    payTravelOrder(args: {
      orderId: string;
      amount: string;
      currency: string;
    }): Promise<DuffelPayment> {
      return this.travelDomain.payTravelOrder(args);
    }

    bookFlightItinerary(
      requestUrl: URL,
      args: {
        offerId?: string | null;
        search?: SearchFlightsRequest | null;
        passengers: ReadonlyArray<TravelBookingPassenger>;
        calendarSync?: TravelCalendarSyncPlan | null;
      },
    ): Promise<FlightBookingExecutionResult> {
      return this.travelDomain.bookFlightItinerary(requestUrl, args);
    }
  }

  return LifeOpsTravelServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsTravelServicePublic
  >;
}
