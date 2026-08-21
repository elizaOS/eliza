/**
 * Travel-booking handler — flight and stay search plus purchase via Duffel.
 * Search results are previewed to the owner; the actual booking only runs
 * through the approval queue via `executeApprovedBookTravel`, never directly
 * from the action handler.
 */
import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  recentConversationTexts as collectRecentConversationTexts,
  ModelType,
  parseJsonModelRecord,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import {
  PaymentRequiredError,
  type X402PaymentRequirement,
} from "@elizaos/plugin-elizacloud/cloud/x402-payment-handler";
import { INTERNAL_URL } from "../lifeops/access.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../lifeops/approval-queue.types.js";
import {
  TravelApprovalDriftError,
  TravelPostBookingProjectionError,
} from "../lifeops/domains/travel-service.js";
import { requireFeatureEnabled } from "../lifeops/feature-flags.js";
import { FeatureNotEnabledError } from "../lifeops/feature-flags.types.js";
import { LifeOpsService } from "../lifeops/service.js";
import type {
  TravelBookingPassenger,
  TravelCalendarSyncPlan,
} from "../lifeops/travel-booking.types.js";
import {
  ApprovalAmbiguousDeliveryError,
  runApprovalDispatch,
} from "./lib/approval-execution.js";
import { ApprovalKnownNonDeliveryError } from "./lib/messaging-helpers.js";

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

function normalizePassengers(value: unknown): TravelBookingPassenger[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((passenger) =>
      passenger && typeof passenger === "object"
        ? normalizePassenger(passenger as BookTravelPassengerInput)
        : null,
    )
    .filter(
      (passenger): passenger is TravelBookingPassenger => passenger !== null,
    );
}

function formatBookTravelPromptValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "none";
    }
    return value
      .map(
        (entry, index) =>
          `item ${index + 1}: ${formatBookTravelPromptValue(entry)}`,
      )
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "none";
    }
    return entries
      .map(([key, entry]) => `${key}: ${formatBookTravelPromptValue(entry)}`)
      .join("\n");
  }
  return String(value);
}

function normalizeCalendarSync(value: unknown): TravelCalendarSyncPlan | null {
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
    normalizedPassengers.length > 0
      ? normalizedPassengers
      : extractedPassengers;
  return {
    offerId: trimToNull(params.offerId) ?? extracted.offerId,
    origin: trimToNull(params.origin) ?? extracted.origin,
    destination: trimToNull(params.destination) ?? extracted.destination,
    departureDate: trimToNull(params.departureDate) ?? extracted.departureDate,
    returnDate: trimToNull(params.returnDate) ?? extracted.returnDate,
    passengerCount:
      typeof params.passengerCount === "number" && params.passengerCount > 0
        ? Math.floor(params.passengerCount)
        : extracted.passengerCount,
    passengers,
    calendarSync: normalizeCalendarSync(params.calendarSync) ??
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
  return typeof message.content.text === "string" ? message.content.text : "";
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
    "Extract structured booking data for PERSONAL_ASSISTANT action=book_travel.",
    "Return JSON only as a single object with exactly these keys:",
    "offerId: string or null",
    "origin: IATA airport code or null",
    "destination: IATA airport code or null",
    "departureDate: YYYY-MM-DD or null",
    "returnDate: YYYY-MM-DD or null",
    "passengerCount: number or null",
    "passengers: passenger records if known; each record may include offerPassengerId, givenName, familyName, bornOn, email, phoneNumber, title, gender",
    "calendarSync: calendar sync object if known; may include enabled, calendarId, title, description, location, timeZone",
    'Example: {"offerId":null,"origin":"SFO","destination":"JFK","departureDate":"2026-06-01","returnDate":null,"passengerCount":1,"passengers":[],"calendarSync":null}',
    "",
    "Rules:",
    "- Do not invent airports, dates, or passenger birthdays.",
    "- Use offerId when the conversation already references a chosen offer.",
    "- Use null for missing values.",
    "- Passenger birthdays must stay in YYYY-MM-DD format when present.",
    "",
    `User message:\n${messageText(args.message)}`,
    "",
    `Current parameters:\n${formatBookTravelPromptValue(args.params)}`,
    "",
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await runWithTrajectoryPurpose("lifeops-book-travel", () =>
      args.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
    );
    const rawText = typeof raw === "string" ? raw : "";
    parsed = parseJsonModelRecord<Record<string, unknown>>(rawText);
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
      ? (parsed.passengers as BookTravelPassengerInput[])
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
  const payload =
    request.payload.action === "book_travel" ? request.payload : null;
  const route = payload?.summary?.trim() || "this itinerary";
  const total =
    typeof payload?.totalCents === "number" && payload.totalCents > 0
      ? `${(payload.totalCents / 100).toFixed(2)} ${payload.currency}`
      : (payload?.currency ?? "the quoted total");
  const orderType =
    payload?.orderType === "hold"
      ? "place a payment-free hold"
      : payload?.orderType === "instant"
        ? "book immediately and pay the approved total"
        : "book";
  const calendarText =
    payload?.orderType === "hold"
      ? " I will not create a calendar event until the hold is separately paid."
      : payload?.calendarSync?.enabled === false
        ? " I will not create a calendar event."
        : " I will sync the itinerary to your calendar.";
  return `Queued travel approval for ${route}. Once you approve, I will ${orderType}.${calendarText} Current quote: ${total}.`;
}

// Internal travel-booking handler. The travel surface is delegated to from the
// registered PERSONAL_ASSISTANT umbrella in owner-surfaces.ts; this module no
// longer publishes a planner-visible Action. Approval execution still lives
// here as `executeApprovedBookTravel` and is invoked by RESOLVE_REQUEST.
export async function runBookTravelHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  try {
    await requireFeatureEnabled(runtime, "travel.book_flight");
  } catch (error) {
    if (error instanceof FeatureNotEnabledError) {
      const text = error.message;
      if (callback) {
        await callback({ text });
      }
      // FEATURE_NOT_ENABLED is a "needs setup / confirmation" terminal
      // state — the action correctly identified what to do; the owner
      // just needs to enable the feature (e.g. sign in to Eliza Cloud).
      return {
        text,
        success: false,
        values: {
          success: false,
          error: error.code,
          featureKey: error.featureKey,
          requiresConfirmation: true,
        },
        data: {
          actionName: "PERSONAL_ASSISTANT",
          action: "book_travel",
          error: error.code,
          featureKey: error.featureKey,
          requiresConfirmation: true,
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
    // Selection + execution were correct: the user asked to book travel,
    // the action ran, and we now need the user to fill in missing trip
    // details. Mark as awaiting-confirmation so the native planner stops
    // chaining and the benchmark scorer treats this as completed.
    return {
      text,
      success: false,
      values: {
        success: false,
        error: "MISSING_BOOKING_DETAILS",
        requiresConfirmation: true,
        missing,
      },
      data: {
        actionName: "PERSONAL_ASSISTANT",
        action: "book_travel",
        error: "MISSING_BOOKING_DETAILS",
        requiresConfirmation: true,
        missing,
      },
    };
  }

  const service = new LifeOpsService(runtime);
  let search: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    passengers: number;
  } | null = null;
  if (!merged.offerId) {
    const { origin, destination, departureDate } = merged;
    if (!origin || !destination || !departureDate) {
      throw new Error(
        "PERSONAL_ASSISTANT action=book_travel validated fields are unexpectedly missing",
      );
    }
    search = {
      origin,
      destination,
      departureDate,
      returnDate: merged.returnDate ?? undefined,
      passengers: merged.passengerCount ?? merged.passengers.length,
    };
  }

  let prepared: Awaited<ReturnType<typeof service.prepareFlightBooking>>;
  try {
    prepared = await service.prepareFlightBooking({
      offerId: merged.offerId,
      search,
      passengers: merged.passengers,
      calendarSync: merged.calendarSync,
    });
  } catch (err) {
    if (
      !(err instanceof PaymentRequiredError) ||
      err.requirements.length === 0
    ) {
      throw err;
    }
    // Surface the x402 payment-required signal as part of the approval
    // entry rather than a hard failure: the user sees the booking
    // intent and the top-up prompt together and can approve once they
    // have credit. We bail out here because we don't have a quoted
    // offer yet — the next book_travel invocation after top-up will
    // re-quote.
    const paymentRequired: X402PaymentRequirement = err.requirements[0];
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    const subjectUserId =
      typeof message.entityId === "string"
        ? message.entityId
        : String(runtime.agentId);
    const request = await queue.enqueue({
      requestedBy: "PERSONAL_ASSISTANT",
      subjectUserId,
      action: "book_travel",
      payload: {
        action: "book_travel",
        kind: "flight",
        provider: "duffel",
        itineraryRef: merged.offerId ?? "pending-quote",
        totalCents: 0,
        currency: "USD",
        offerId: merged.offerId,
        summary: merged.offerId
          ? `Booking for offer ${merged.offerId}`
          : `${merged.origin ?? "?"} → ${merged.destination ?? "?"}`,
        cost: null,
        paymentRequired: {
          amount: paymentRequired.amount,
          asset: paymentRequired.asset,
          network: paymentRequired.network,
          payTo: paymentRequired.payTo,
          scheme: paymentRequired.scheme,
          expiresAt: paymentRequired.expiresAt,
          description: paymentRequired.description,
        },
      },
      channel: "internal",
      reason: `Top up ${paymentRequired.amount} ${paymentRequired.asset} on ${paymentRequired.network} to book travel`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const text = `Eliza Cloud needs a top-up before I can quote this trip: ${paymentRequired.amount} ${paymentRequired.asset} on ${paymentRequired.network}. I queued it for approval so you can review and pay together.`;
    if (callback) {
      await callback({ text });
    }
    return {
      text,
      success: false,
      values: {
        success: false,
        error: err.code,
        requestId: request.id,
        requiresConfirmation: true,
      },
      data: {
        actionName: "PERSONAL_ASSISTANT",
        action: "book_travel",
        error: err.code,
        requestId: request.id,
        requiresConfirmation: true,
        paymentRequired: {
          asset: paymentRequired.asset,
          network: paymentRequired.network,
          amount: paymentRequired.amount,
        },
      },
    };
  }

  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  const subjectUserId =
    typeof message.entityId === "string"
      ? message.entityId
      : String(runtime.agentId);
  const request = await queue.enqueue({
    requestedBy: "PERSONAL_ASSISTANT",
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
      actionName: "PERSONAL_ASSISTANT",
      action: "book_travel",
      requestId: request.id,
      state: request.state,
      offerId: prepared.offer.id,
      totalAmount: prepared.offer.totalAmount,
      totalCurrency: prepared.offer.totalCurrency,
      orderType: prepared.orderType,
    },
  };
}

// Callback invoked by the approval queue once an owner approves a queued
// book_travel request. The resolve-request action dispatches here after
// a request transitions from pending -> approved.
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
  if (
    !payload.offerId ||
    (payload.orderType !== "hold" && payload.orderType !== "instant") ||
    !Number.isInteger(payload.totalCents) ||
    payload.totalCents <= 0 ||
    !payload.currency?.trim()
  ) {
    throw new Error(
      "Approved travel booking is missing its immutable offer, order type, or quoted price",
    );
  }
  const approvedQuote = {
    offerId: payload.offerId,
    orderType: payload.orderType,
    totalCents: payload.totalCents,
    currency: payload.currency,
  } as const;
  const passengers = Array.isArray(payload.passengers)
    ? payload.passengers
    : [];
  if (passengers.length === 0) {
    throw new Error("Approved travel booking is missing passenger details");
  }

  const service = new LifeOpsService(args.runtime);
  const status = service.getTravelConnectorStatus();
  if (!status.connected) {
    return {
      text: "",
      success: false,
      data: {
        error: "TRAVEL_CONNECTOR_NOT_CONNECTED",
        requestId: args.request.id,
        state: args.request.state,
        executed: false,
      },
    };
  }
  let calendarGrantId: string | undefined;
  if (
    payload.orderType === "instant" &&
    payload.calendarSync?.enabled !== false
  ) {
    try {
      const grant = await service.requireGoogleCalendarWriteGrant(
        INTERNAL_URL,
        "local",
        "owner",
      );
      calendarGrantId = grant.id;
    } catch (error) {
      return {
        text: "",
        success: false,
        data: {
          error: "TRAVEL_CALENDAR_PREFLIGHT_FAILED",
          detail: error instanceof Error ? error.message : String(error),
          requestId: args.request.id,
          state: args.request.state,
          executed: false,
        },
      };
    }
  }
  const outcome = await runApprovalDispatch({
    queue: args.queue,
    request: args.request,
    subjectUserId: args.request.subjectUserId,
    prepared: {
      provider: "duffel",
      dispatch: async (providerIdempotencyKey) => {
        let booked: Awaited<ReturnType<LifeOpsService["bookFlightItinerary"]>>;
        try {
          booked = await service.bookFlightItinerary(INTERNAL_URL, {
            offerId: payload.offerId ?? null,
            search: payload.search ?? null,
            passengers,
            calendarSync: payload.calendarSync ?? null,
            calendarGrantId,
            approved: approvedQuote,
            providerIdempotencyKey,
          });
        } catch (error) {
          if (error instanceof TravelApprovalDriftError) {
            throw new ApprovalKnownNonDeliveryError(
              "TRAVEL_APPROVED_QUOTE_CHANGED",
              error.message,
            );
          }
          if (error instanceof TravelPostBookingProjectionError) {
            throw new ApprovalAmbiguousDeliveryError(
              error.message,
              {
                provider: "duffel",
                orderId: error.booking.order.id,
                bookingReference: error.booking.order.bookingReference ?? null,
                orderType: error.booking.orderType,
                paymentCommitted: error.booking.paymentCommitted,
                paymentId: error.booking.payment?.id ?? null,
                projectionComplete: false,
              },
              { cause: error },
            );
          }
          throw error;
        }
        return {
          value: booked,
          receipt: {
            provider: "duffel",
            orderId: booked.order.id,
            bookingReference: booked.order.bookingReference ?? null,
            orderType: booked.orderType,
            paymentCommitted: booked.paymentCommitted,
            paymentId: booked.payment?.id ?? null,
          },
        };
      },
    },
  });
  if (outcome.kind !== "delivered") {
    const reconciliationRequired = outcome.kind === "reconciliation_required";
    return {
      text: "",
      success: false,
      data: {
        error: reconciliationRequired
          ? "APPROVAL_RECONCILIATION_REQUIRED"
          : "APPROVAL_DELIVERY_FAILED_RETRYABLE",
        detail: outcome.error.message,
        requestId: args.request.id,
        state: outcome.request.state,
        attemptId: outcome.request.execution?.attemptId ?? null,
        executed: reconciliationRequired ? null : false,
        deliveryUnknown: reconciliationRequired,
      },
    };
  }
  const booked = outcome.value;
  const done = outcome.request;

  const route = payload.summary?.trim() || `${booked.offer.id}`;
  const bookingReference = booked.order.bookingReference
    ? ` Booking reference: ${booked.order.bookingReference}.`
    : "";
  const paymentText = booked.payment
    ? ` Payment ${booked.payment.id} captured for ${booked.payment.amount} ${booked.payment.currency}.`
    : booked.paymentCommitted
      ? ` The approved ${booked.offer.totalAmount} ${booked.offer.totalCurrency} payment was submitted with the instant order.`
      : " No payment was submitted.";
  const calendarText = booked.calendarEvent
    ? ` Synced to calendar as "${booked.calendarEvent.title}".`
    : "";
  const outcomeVerb = booked.orderType === "hold" ? "Held" : "Booked";
  const text =
    `${outcomeVerb} ${route}.${bookingReference}${paymentText}${calendarText}`.trim();

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
      orderType: booked.orderType,
      paymentCommitted: booked.paymentCommitted,
      paymentId: booked.payment?.id ?? null,
      calendarEventId: booked.calendarEvent?.id ?? null,
    },
    data: {
      actionName: "PERSONAL_ASSISTANT",
      action: "book_travel",
      requestId: done.id,
      state: done.state,
      bookingReference: booked.order.bookingReference,
      orderId: booked.order.id,
      orderType: booked.orderType,
      paymentCommitted: booked.paymentCommitted,
      paymentId: booked.payment?.id ?? null,
      calendarEventId: booked.calendarEvent?.id ?? null,
      offerId: booked.offer.id,
    },
  };
}
