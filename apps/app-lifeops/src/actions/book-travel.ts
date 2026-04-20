import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../lifeops/approval-queue.types.js";
import { requireFeatureEnabled } from "../lifeops/feature-flags.js";
import { FeatureNotEnabledError } from "../lifeops/feature-flags.types.js";
import { INTERNAL_URL } from "./lifeops-google-helpers.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import { LifeOpsService } from "../lifeops/service.js";
import type {
  TravelBookingPassenger,
  TravelCalendarSyncPlan,
} from "../lifeops/travel-booking.types.js";

type BookTravelPassengerInput = {
  offerPassengerId?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  bornOn?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  title?: string | null;
  gender?: string | null;
};

type BookTravelParameters = {
  offerId?: string;
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  passengers?: BookTravelPassengerInput[];
  passengerCount?: number;
  calendarSync?: Partial<TravelCalendarSyncPlan> | null;
};

type ExtractedBookTravelPlan = {
  offerId: string | null;
  origin: string | null;
  destination: string | null;
  departureDate: string | null;
  returnDate: string | null;
  passengerCount: number | null;
  passengers: BookTravelPassengerInput[];
  calendarSync: Partial<TravelCalendarSyncPlan> | null;
};

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePassenger(
  value: BookTravelPassengerInput,
): TravelBookingPassenger | null {
  const givenName = trimToNull(value.givenName);
  const familyName = trimToNull(value.familyName);
  const bornOn = trimToNull(value.bornOn);
  if (!givenName || !familyName || !bornOn) {
    return null;
  }
  return {
    offerPassengerId: trimToNull(value.offerPassengerId),
    givenName,
    familyName,
    bornOn,
    email: trimToNull(value.email),
    phoneNumber: trimToNull(value.phoneNumber),
    title: trimToNull(value.title),
    gender: trimToNull(value.gender),
  };
}

function normalizePassengers(
  value: unknown,
): TravelBookingPassenger[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((passenger) =>
      passenger && typeof passenger === "object"
        ? normalizePassenger(passenger as BookTravelPassengerInput)
        : null,
    )
    .filter((passenger): passenger is TravelBookingPassenger => passenger !== null);
}

function normalizeCalendarSync(
  value: unknown,
): TravelCalendarSyncPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled !== false,
    calendarId: trimToNull(record.calendarId),
    title: trimToNull(record.title),
    description: trimToNull(record.description),
    location: trimToNull(record.location),
    timeZone: trimToNull(record.timeZone),
  };
}

function mergePlans(
  params: BookTravelParameters,
  extracted: ExtractedBookTravelPlan,
): {
  offerId: string | null;
  origin: string | null;
  destination: string | null;
  departureDate: string | null;
  returnDate: string | null;
  passengerCount: number | null;
  passengers: TravelBookingPassenger[];
  calendarSync: TravelCalendarSyncPlan | null;
} {
  const normalizedPassengers = normalizePassengers(params.passengers);
  const extractedPassengers = normalizePassengers(extracted.passengers);
  const passengers =
    normalizedPassengers.length > 0 ? normalizedPassengers : extractedPassengers;
  return {
    offerId: trimToNull(params.offerId) ?? extracted.offerId,
    origin: trimToNull(params.origin) ?? extracted.origin,
    destination: trimToNull(params.destination) ?? extracted.destination,
    departureDate:
      trimToNull(params.departureDate) ?? extracted.departureDate,
    returnDate: trimToNull(params.returnDate) ?? extracted.returnDate,
    passengerCount:
      typeof params.passengerCount === "number" && params.passengerCount > 0
        ? Math.floor(params.passengerCount)
        : extracted.passengerCount,
    passengers,
    calendarSync:
      normalizeCalendarSync(params.calendarSync) ??
      normalizeCalendarSync(extracted.calendarSync) ?? {
        enabled: true,
        calendarId: "primary",
        title: null,
        description: null,
        location: null,
        timeZone: null,
      },
  };
}

function getParams(options: HandlerOptions | undefined): BookTravelParameters {
  return ((options?.parameters as BookTravelParameters | undefined) ??
    {}) as BookTravelParameters;
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

async function extractBookTravelPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  params: BookTravelParameters;
}): Promise<ExtractedBookTravelPlan> {
  if (typeof args.runtime.useModel !== "function") {
    return {
      offerId: null,
      origin: null,
      destination: null,
      departureDate: null,
      returnDate: null,
      passengerCount: null,
      passengers: [],
      calendarSync: null,
    };
  }

  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 6,
    })
  ).join("\n");

  const prompt = [
    "Extract structured booking data for the BOOK_TRAVEL action.",
    "Return ONLY valid JSON with exactly these keys:",
    '{"offerId":string|null,"origin":string|null,"destination":string|null,"departureDate":string|null,"returnDate":string|null,"passengerCount":number|null,"passengers":[{"offerPassengerId":string|null,"givenName":string|null,"familyName":string|null,"bornOn":string|null,"email":string|null,"phoneNumber":string|null,"title":string|null,"gender":string|null}],"calendarSync":{"enabled":boolean|null,"calendarId":string|null,"title":string|null,"description":string|null,"location":string|null,"timeZone":string|null}|null}',
    "",
    "Rules:",
    "- Do not invent airports, dates, or passenger birthdays.",
    "- Use offerId when the conversation already references a chosen offer.",
    "- Use null for missing values.",
    "- Passenger birthdays must stay in YYYY-MM-DD format when present.",
    "",
    `User message:\n${messageText(args.message)}`,
    "",
    `Current parameters:\n${JSON.stringify(args.params)}`,
    "",
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    parsed = parseJSONObjectFromText(
      typeof raw === "string" ? raw : "",
    ) as Record<string, unknown> | null;
  } catch {
    parsed = null;
  }

  return {
    offerId: trimToNull(parsed?.offerId),
    origin: trimToNull(parsed?.origin),
    destination: trimToNull(parsed?.destination),
    departureDate: trimToNull(parsed?.departureDate),
    returnDate: trimToNull(parsed?.returnDate),
    passengerCount:
      typeof parsed?.passengerCount === "number" &&
      Number.isFinite(parsed.passengerCount)
        ? Math.max(1, Math.floor(parsed.passengerCount))
        : null,
    passengers: Array.isArray(parsed?.passengers)
      ? (parsed?.passengers as BookTravelPassengerInput[])
      : [],
    calendarSync:
      parsed?.calendarSync && typeof parsed.calendarSync === "object"
        ? (parsed.calendarSync as Partial<TravelCalendarSyncPlan>)
        : null,
  };
}

function listMissingPassengerFields(
  passengers: TravelBookingPassenger[],
): string[] {
  if (passengers.length > 0) {
    return [];
  }
  return [
    "passenger given name",
    "passenger family name",
    "passenger date of birth",
  ];
}

function buildMissingInfoText(missing: string[]): string {
  return `I can queue the booking once I have ${missing.join(", ")}.`;
}

function buildApprovalText(request: ApprovalRequest): string {
  const payload = request.payload.action === "book_travel" ? request.payload : null;
  const route = payload?.summary?.trim() || "this itinerary";
  const total =
    typeof payload?.totalCents === "number" && payload.totalCents > 0
      ? `${(payload.totalCents / 100).toFixed(2)} ${payload.currency}`
      : payload?.currency ?? "the quoted total";
  const orderType =
    payload?.orderType === "hold"
      ? "hold then pay"
      : payload?.orderType === "instant"
        ? "book immediately"
        : "book";
  return `Queued travel approval ${request.id} for ${route}. Once you approve, I will ${orderType}, complete payment, and sync the itinerary to your calendar. Current quote: ${total}.`;
}

export async function executeApprovedBookTravel(args: {
  runtime: IAgentRuntime;
  queue: ApprovalQueue;
  request: ApprovalRequest;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  if (args.request.payload.action !== "book_travel") {
    throw new Error("executeApprovedBookTravel received a non-travel request");
  }
  const payload = args.request.payload;
  if (payload.kind !== "flight") {
    throw new Error(`Unsupported travel kind: ${payload.kind}`);
  }
  if (!payload.offerId && !payload.search) {
    throw new Error("Approved travel booking is missing offer/search context");
  }
  const passengers = Array.isArray(payload.passengers) ? payload.passengers : [];
  if (passengers.length === 0) {
    throw new Error("Approved travel booking is missing passenger details");
  }

  await args.queue.markExecuting(args.request.id);
  const service = new LifeOpsService(args.runtime);
  const booked = await service.bookFlightItinerary(INTERNAL_URL, {
    offerId: payload.offerId ?? null,
    search: payload.search ?? null,
    passengers,
    calendarSync: payload.calendarSync ?? null,
  });
  const done = await args.queue.markDone(args.request.id);

  const route = payload.summary?.trim() || `${booked.offer.id}`;
  const bookingReference = booked.order.bookingReference
    ? ` Booking reference: ${booked.order.bookingReference}.`
    : "";
  const paymentText = booked.payment
    ? ` Payment ${booked.payment.id} captured for ${booked.payment.amount} ${booked.payment.currency}.`
    : "";
  const calendarText = booked.calendarEvent
    ? ` Synced to calendar as "${booked.calendarEvent.title}".`
    : "";
  const text = `Booked ${route}.${bookingReference}${paymentText}${calendarText}`.trim();

  if (args.callback) {
    await args.callback({ text });
  }

  return {
    text,
    success: true,
    values: {
      success: true,
      requestId: done.id,
      bookingReference: booked.order.bookingReference,
      orderId: booked.order.id,
      paymentId: booked.payment?.id ?? null,
      calendarEventId: booked.calendarEvent?.id ?? null,
    },
    data: {
      actionName: "BOOK_TRAVEL",
      requestId: done.id,
      state: done.state,
      bookingReference: booked.order.bookingReference,
      orderId: booked.order.id,
      paymentId: booked.payment?.id ?? null,
      calendarEventId: booked.calendarEvent?.id ?? null,
      offerId: booked.offer.id,
    },
  };
}

export const bookTravelAction: Action = {
  name: "BOOK_TRAVEL",
  similes: [
    "TRAVEL_BOOKING",
    "BOOK_FLIGHT",
    "BOOK_TRIP",
    "LOCK_IT_IN",
    "HOLD_AND_BOOK_FLIGHT",
    "QUEUE_TRAVEL_FOR_APPROVAL",
  ],
  description:
    "Search, prepare, and approval-gate real travel booking. Use for flight or hotel booking requests that should become a real booking after explicit approval, with calendar sync once completed. This action still owns the turn when the owner is asking you to prepare the booking package now and hold it for approval, or when some itinerary details still need a follow-up before the approval queue entry can be finalized.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message, state, options, callback) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "BOOK_TRAVEL", error: "PERMISSION_DENIED" },
      };
    }

    try {
      await requireFeatureEnabled(runtime, "travel.book_flight");
    } catch (error) {
      if (error instanceof FeatureNotEnabledError) {
        const text = error.message;
        if (callback) {
          await callback({ text });
        }
        return {
          text,
          success: false,
          values: {
            success: false,
            error: error.code,
            featureKey: error.featureKey,
          },
          data: {
            actionName: "BOOK_TRAVEL",
            error: error.code,
            featureKey: error.featureKey,
          },
        };
      }
      throw error;
    }

    const params = getParams(options as HandlerOptions | undefined);
    const extracted = await extractBookTravelPlanWithLlm({
      runtime,
      message,
      state,
      params,
    });
    const merged = mergePlans(params, extracted);

    const missing: string[] = [];
    if (!merged.offerId) {
      if (!merged.origin) {
        missing.push("origin airport");
      }
      if (!merged.destination) {
        missing.push("destination airport");
      }
      if (!merged.departureDate) {
        missing.push("departure date");
      }
    }
    missing.push(...listMissingPassengerFields(merged.passengers));
    if (missing.length > 0) {
      const text = buildMissingInfoText(missing);
      if (callback) {
        await callback({ text });
      }
      return {
        text,
        success: false,
        values: { success: false, error: "MISSING_BOOKING_DETAILS", missing },
        data: {
          actionName: "BOOK_TRAVEL",
          error: "MISSING_BOOKING_DETAILS",
          missing,
        },
      };
    }

    const service = new LifeOpsService(runtime);
    const prepared = await service.prepareFlightBooking({
      offerId: merged.offerId,
      search: merged.offerId
        ? null
        : {
            origin: merged.origin!,
            destination: merged.destination!,
            departureDate: merged.departureDate!,
            returnDate: merged.returnDate ?? undefined,
            passengers: merged.passengerCount ?? merged.passengers.length,
          },
      passengers: merged.passengers,
      calendarSync: merged.calendarSync,
    });

    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    const subjectUserId =
      typeof message.entityId === "string"
        ? message.entityId
        : String(runtime.agentId);
    const request = await queue.enqueue({
      requestedBy: "BOOK_TRAVEL",
      subjectUserId,
      action: "book_travel",
      payload: {
        action: "book_travel",
        ...prepared.payload,
      },
      channel: "internal",
      reason: `Book ${prepared.payload.summary ?? "travel itinerary"} after explicit approval`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const text = buildApprovalText(request);
    if (callback) {
      await callback({ text });
    }

    return {
      text,
      success: true,
      values: {
        success: true,
        requestId: request.id,
        state: request.state,
        offerId: prepared.offer.id,
      },
      data: {
        actionName: "BOOK_TRAVEL",
        requestId: request.id,
        state: request.state,
        offerId: prepared.offer.id,
        totalAmount: prepared.offer.totalAmount,
        totalCurrency: prepared.offer.totalCurrency,
        orderType: prepared.orderType,
      },
    };
  },
  parameters: [
    {
      name: "offerId",
      description:
        "Duffel offer id to book if a concrete offer was already chosen.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "origin",
      description: "Origin IATA airport code when searching for a flight.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "destination",
      description: "Destination IATA airport code when searching for a flight.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "departureDate",
      description: "Departure date in YYYY-MM-DD format.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "returnDate",
      description: "Optional return date in YYYY-MM-DD format.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "passengers",
      description:
        "Passenger details required to create the booking after approval.",
      required: false,
      schema: { type: "array" as const },
    },
    {
      name: "calendarSync",
      description:
        "Optional calendar sync metadata for the booked itinerary event.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Book the JFK to LHR flight for Tony Stark, born 1980-07-24, and sync it to my calendar once I approve.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Queued travel approval for the selected itinerary. Once you approve, I'll book it and sync it to your calendar.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Hold that flight for me and finish the booking after I confirm.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I queued the booking behind approval. Once you approve, I'll complete payment and add the itinerary to your calendar.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Jill confirmed it will just be me for LA and Toronto. Put together the flights and hotel and hold it for my approval before you book anything.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll prepare the flights and hotel for LA and Toronto and queue the booking behind your approval before anything gets finalized.",
        },
      },
    ],
  ] as ActionExample[][],
};
