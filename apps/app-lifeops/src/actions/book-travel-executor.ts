import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
} from "@elizaos/core";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../lifeops/approval-queue.types.js";
import { LifeOpsService } from "../lifeops/service.js";
import { INTERNAL_URL } from "./lifeops-google-helpers.js";

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
  const passengers = Array.isArray(payload.passengers)
    ? payload.passengers
    : [];
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
  const text =
    `Booked ${route}.${bookingReference}${paymentText}${calendarText}`.trim();

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
