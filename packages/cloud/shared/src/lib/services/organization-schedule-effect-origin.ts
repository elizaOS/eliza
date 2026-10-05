/** Original schedule request attribution. Callers authenticate transport before projection. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
import {
  type OrganizationScheduleEffectRequest,
  organizationScheduleEffectReceiptSchema,
  organizationScheduleEffectRequestSchema,
} from "./organization-schedule-effect-contract";
import { settlementDigest } from "./settlement-digest";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const seconds = z.number().int().nonnegative().safe();
// Preserve the complete financial snapshot in the evidence digest, not just its identity.
// This does not validate phase semantics or authorize publication/configuration.
const scheduleSchema = z.looseObject({
  id: id("sub_sched"),
  object: z.literal("subscription_schedule"),
  customer: id("cus"),
  subscription: id("sub"),
  livemode: z.boolean(),
  created: seconds,
  application: z.null(),
  status: z.literal("active"),
  canceled_at: z.null(),
  completed_at: z.null(),
  released_at: z.null(),
  released_subscription: z.null(),
  end_behavior: z.enum(["release", "cancel"]),
  current_phase: z.object({ start_date: seconds, end_date: seconds }),
  phases: z.array(z.record(z.string(), z.unknown())).min(1),
  default_settings: z.record(z.string(), z.unknown()),
});
const transportSchema = z.object({
  requestId: id("req"),
  statusCode: z.literal(200),
  apiVersion: z.literal(GENERIC_BILLING_STRIPE_API_VERSION),
  idempotencyKey: z.string().min(1),
  stripeAccount: z.never().optional(),
});
const eventSchema = z.object({
  id: id("evt"),
  object: z.literal("event"),
  type: z.enum(["subscription_schedule.created", "subscription_schedule.updated"]),
  api_version: z.literal(GENERIC_BILLING_STRIPE_API_VERSION),
  created: seconds,
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  request: z.object({ id: id("req"), idempotency_key: z.string().min(1) }),
  data: z.object({ object: scheduleSchema }),
});
interface OriginalScheduleRequest {
  request: OrganizationScheduleEffectRequest;
  providerIdempotencyKey: string;
  customerId: string;
  subscriptionId: string;
  livemode: boolean;
  /** Persisted first dispatch time, never the replacement recovery lease time. */
  startedAt: Date;
}
function reject(): never {
  throw new ElizaError("Original schedule request attribution is unavailable", {
    code: "SUBSCRIPTION_SCHEDULE_ORIGIN_UNVERIFIED",
  });
}
function validateScope(
  schedule: z.infer<typeof scheduleSchema>,
  original: OriginalScheduleRequest,
  observedAt: Date,
) {
  const parsed = organizationScheduleEffectRequestSchema.safeParse(original.request);
  if (!parsed.success) reject();
  const request = parsed.data;
  const started = Math.floor(original.startedAt.getTime() / 1000);
  const observed = Math.floor(observedAt.getTime() / 1000);
  if (
    !Number.isSafeInteger(started) ||
    !Number.isSafeInteger(observed) ||
    started < 0 ||
    observedAt.getTime() < original.startedAt.getTime() ||
    schedule.customer !== original.customerId ||
    schedule.subscription !== original.subscriptionId ||
    schedule.livemode !== original.livemode ||
    schedule.created > observed ||
    schedule.current_phase.end_date <= schedule.current_phase.start_date ||
    (request.kind === "schedule_create" &&
      (request.subscriptionId !== original.subscriptionId || schedule.created < started)) ||
    (request.kind === "schedule_configure" && schedule.id !== request.scheduleId)
  )
    reject();
  return { request, started, observed };
}

/** Only pass the original create/update SDK response, with its non-enumerable lastResponse.
 * A retrieve response is not original POST evidence. Signature verification or trusted
 * platform SDK I/O is a caller boundary; renderer objects must never reach this function.
 * Receipt attribution does not establish retained terms, configured phases or payment.
 */
export function projectOriginalScheduleResponse(input: {
  raw: unknown;
  originalRequest: OriginalScheduleRequest;
  observedAt: Date;
}) {
  // Read transport separately: SDK lastResponse is non-enumerable and object spreading loses it.
  const parsed = z.object({ lastResponse: transportSchema }).safeParse(input.raw);
  const body = scheduleSchema.safeParse(input.raw);
  if (!parsed.success || !body.success) reject();
  const transport = parsed.data.lastResponse;
  const schedule = body.data;
  validateScope(schedule, input.originalRequest, input.observedAt);
  if (transport.idempotencyKey !== input.originalRequest.providerIdempotencyKey) reject();
  // Do not retain arbitrary response headers or SDK request metadata in the evidence.
  const { lastResponse: _transport, ...snapshot } = schedule;
  return organizationScheduleEffectReceiptSchema.parse({
    kind: "response",
    scheduleId: schedule.id,
    customerId: schedule.customer,
    subscriptionId: schedule.subscription,
    livemode: schedule.livemode,
    apiVersion: transport.apiVersion,
    providerRequestId: transport.requestId,
    providerIdempotencyKey: transport.idempotencyKey,
    eventId: null,
    evidenceDigest: settlementDigest({ schedule: snapshot, transport }),
    observedAt: input.observedAt.toISOString(),
  });
}

/** Accept only signature-verified events or events retrieved from the platform account.
 * Automated phase transitions and events from another request cannot prove this effect.
 * The event snapshot is historical evidence; re-read state before any further mutation.
 */
export function projectAuthenticatedScheduleEvent(input: {
  raw: unknown;
  originalRequest: OriginalScheduleRequest;
  observedAt: Date;
}) {
  const parsed = eventSchema.safeParse(input.raw);
  if (!parsed.success) reject();
  const event = parsed.data;
  const schedule = event.data.object;
  const { request, started, observed } = validateScope(
    schedule,
    input.originalRequest,
    input.observedAt,
  );
  if (
    event.type !==
      (request.kind === "schedule_create"
        ? "subscription_schedule.created"
        : "subscription_schedule.updated") ||
    event.request.idempotency_key !== input.originalRequest.providerIdempotencyKey ||
    event.livemode !== input.originalRequest.livemode ||
    event.created < started ||
    event.created < schedule.created ||
    event.created > observed
  )
    reject();
  return organizationScheduleEffectReceiptSchema.parse({
    kind: "event",
    scheduleId: schedule.id,
    customerId: schedule.customer,
    subscriptionId: schedule.subscription,
    livemode: schedule.livemode,
    apiVersion: event.api_version,
    providerRequestId: event.request.id,
    providerIdempotencyKey: event.request.idempotency_key,
    eventId: event.id,
    evidenceDigest: settlementDigest(event),
    observedAt: input.observedAt.toISOString(),
  });
}
