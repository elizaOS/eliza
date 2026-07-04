/**
 * Travel service mixin: declares the LifeOps travel-booking service surface and
 * the mixin that composes the travel domain's flight-search and booking methods
 * onto the LifeOpsService base.
 */
import type {
  DuffelOffer,
  DuffelOrder,
  DuffelPayment,
  SearchFlightsRequest,
  SearchFlightsResult,
} from "@elizaos/plugin-elizacloud/cloud/duffel-client";
import type { TravelDomain } from "./domains/travel-service.js";
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
