import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import type {
  DuffelOffer,
  DuffelOrder,
  DuffelPayment,
  SearchFlightsRequest,
} from "./travel-adapters/duffel.js";

export interface TravelBookingPassenger {
  readonly offerPassengerId?: string | null;
  readonly givenName: string;
  readonly familyName: string;
  readonly bornOn: string;
  readonly email?: string | null;
  readonly phoneNumber?: string | null;
  readonly title?: string | null;
  readonly gender?: string | null;
}

export interface TravelCalendarSyncPlan {
  readonly enabled: boolean;
  readonly calendarId?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly timeZone?: string | null;
}

export interface TravelBookingPayloadFields {
  readonly kind: "flight" | "hotel" | "ground";
  readonly provider: string;
  readonly itineraryRef: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly offerId?: string | null;
  readonly offerRequestId?: string | null;
  readonly orderType?: "hold" | "instant" | null;
  readonly search?: SearchFlightsRequest | null;
  readonly passengers?: ReadonlyArray<TravelBookingPassenger>;
  readonly calendarSync?: TravelCalendarSyncPlan | null;
  readonly summary?: string | null;
}

export interface PreparedFlightBooking {
  readonly offer: DuffelOffer;
  readonly orderType: "hold" | "instant";
  readonly payload: TravelBookingPayloadFields;
}

export interface FlightBookingExecutionResult {
  readonly offer: DuffelOffer;
  readonly order: DuffelOrder;
  readonly payment: DuffelPayment | null;
  readonly calendarEvent: LifeOpsCalendarEvent | null;
}
