/** Verifies and persists Twilio lifecycle callbacks for user-authorized outbound calls. */

import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite, writeTransaction } from "@/db/helpers";
import { twilioCallStatusEvents, twilioOutboundCalls } from "@/db/schemas";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import { verifyTwilioSignature } from "@/lib/utils/twilio-api";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  isTerminalTwilioCallStatus,
  normalizeTwilioProviderCallStatus,
  parseTwilioSequenceNumber,
} from "../lib/twilio-call-status";
import { resolveTwilioPublicUrl } from "../lib/twilio-public-url";

const app = new Hono<AppEnv>();

interface PublicTwilioEnv {
  TWILIO_AUTH_TOKEN?: string;
  ELIZA_APP_TWILIO_AUTH_TOKEN?: string;
}

const StatusPayload = z
  .object({
    CallSid: z.string().min(1),
    AccountSid: z.string().min(1),
    CallStatus: z.string().min(1),
    SequenceNumber: z.string().min(1),
    From: z.string().min(1),
    To: z.string().min(1),
    Timestamp: z.string().optional(),
    ErrorCode: z.string().optional(),
  })
  .passthrough();

app.post("/", async (c) => {
  const requestId = z.string().uuid().safeParse(c.req.query("requestId"));
  if (!requestId.success)
    return new Response("Invalid request id", { status: 400 });

  const rawBody = await c.req.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const parsed = StatusPayload.safeParse(params);
  if (!parsed.success) return new Response("Invalid payload", { status: 400 });

  const event = parsed.data;
  const status = normalizeTwilioProviderCallStatus(event.CallStatus);
  const sequence = parseTwilioSequenceNumber(event.SequenceNumber);
  if (!status || sequence === null)
    return new Response("Invalid call status", { status: 400 });

  const env = c.env as unknown as PublicTwilioEnv;
  const authToken = (
    env.TWILIO_AUTH_TOKEN ?? env.ELIZA_APP_TWILIO_AUTH_TOKEN
  )?.trim();
  if (!authToken)
    return new Response("Twilio auth token not configured", { status: 503 });

  const publicUrl = resolveTwilioPublicUrl(c, "/api/v1/twilio/voice/status");
  const signature = c.req.header("x-twilio-signature") ?? "";
  if (
    !(await verifyTwilioSignature(
      authToken,
      signature,
      publicUrl.toString(),
      params,
    ))
  ) {
    return new Response("Invalid signature", { status: 403 });
  }

  const [call] = await dbWrite
    .select({
      id: twilioOutboundCalls.id,
      callSid: twilioOutboundCalls.call_sid,
      accountSid: twilioOutboundCalls.account_sid,
      from: twilioOutboundCalls.from_number,
      to: twilioOutboundCalls.to_number,
    })
    .from(twilioOutboundCalls)
    .where(eq(twilioOutboundCalls.id, requestId.data))
    .limit(1);
  if (!call) return new Response("Unknown call", { status: 404 });
  if (
    event.AccountSid !== call.accountSid ||
    (call.callSid !== null && event.CallSid !== call.callSid) ||
    normalizePhoneNumber(event.From) !== call.from ||
    normalizePhoneNumber(event.To) !== call.to
  ) {
    return new Response("Call identity mismatch", { status: 403 });
  }

  const timestamp = event.Timestamp ? new Date(event.Timestamp) : null;
  const providerTimestamp =
    timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null;
  const eventDigest = createHash("sha256")
    .update(
      [
        requestId.data,
        event.CallSid,
        status,
        String(sequence),
        event.Timestamp ?? "",
      ].join(":"),
    )
    .digest("hex");
  const receivedAt = new Date();
  const receipt = {
    CallSid: event.CallSid,
    AccountSid: event.AccountSid,
    CallStatus: status,
    SequenceNumber: String(sequence),
    ...(event.Timestamp ? { Timestamp: event.Timestamp } : {}),
    ...(event.ErrorCode ? { ErrorCode: event.ErrorCode } : {}),
  };

  await writeTransaction(async (tx) => {
    await tx
      .insert(twilioCallStatusEvents)
      .values({
        event_digest: eventDigest,
        outbound_call_id: call.id,
        call_sid: event.CallSid,
        call_status: status,
        sequence_number: sequence,
        provider_timestamp: providerTimestamp,
        provider_error_code: event.ErrorCode ?? null,
        receipt,
        received_at: receivedAt,
      })
      .onConflictDoNothing();

    await tx
      .update(twilioOutboundCalls)
      .set({
        call_sid: event.CallSid,
        call_status: status,
        last_status_sequence: sequence,
        ...(status === "in-progress"
          ? { answered_at: providerTimestamp ?? receivedAt }
          : {}),
        terminal_at: isTerminalTwilioCallStatus(status)
          ? (providerTimestamp ?? receivedAt)
          : null,
        provider_error_code: event.ErrorCode ?? null,
        updated_at: receivedAt,
      })
      .where(
        and(
          eq(twilioOutboundCalls.id, call.id),
          lt(twilioOutboundCalls.last_status_sequence, sequence),
        ),
      );
  });

  logger.info("[twilio-voice-status] persisted signed call receipt", {
    callId: call.id,
    callSid: event.CallSid,
    status,
    sequence,
  });
  return new Response(null, { status: 204 });
});

export default app;
