/**
 * Twilio voice inbound webhook.
 *
 * Records the incoming call envelope and returns TwiML that plays a short
 * acknowledgement. Full voice-AI routing (Media Streams → agent → TwiML
 * Say/Gather loop) is deliberately out of scope for T9e; this lands the call
 * receipt on the DB so downstream voice plugins (future work) can pick it up.
 *
 * The route intentionally does not require a bearer token — Twilio does not
 * send one. Signature verification uses `X-Twilio-Signature` against the
 * account-level auth token. If the token is not configured we refuse to
 * record the call to avoid trusting unsigned payloads in production.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { agentPhoneNumbers, twilioInboundCalls } from "@/db/schemas";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { offloadJsonField } from "@/lib/storage/object-store";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import { verifyTwilioSignature } from "@/lib/utils/twilio-api";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const TwilioVoicePayloadSchema = z
  .object({
    CallSid: z.string().min(1),
    AccountSid: z.string().min(1),
    From: z.string().min(1),
    To: z.string().min(1),
    CallStatus: z.string().min(1),
  })
  .passthrough();

const TWIML_ACK = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks — your call is being routed to the assistant.</Say></Response>`;

function resolveForwardedUrl(c: AppContext): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  if (forwardedHost) url.host = forwardedHost;
  const publicUrl = c.env.TWILIO_PUBLIC_URL as string | undefined;
  if (publicUrl) {
    const publicBase = new URL(publicUrl);
    url.protocol = publicBase.protocol;
    url.host = publicBase.host;
  }
  return url.toString();
}

app.post("/", async (c) => {
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    params[key] = value;
  }

  const authToken = (c.env.TWILIO_AUTH_TOKEN as string | undefined)?.trim();
  if (!authToken) {
    logger.warn("[twilio-voice-inbound] TWILIO_AUTH_TOKEN not configured — refusing call");
    return new Response("Twilio auth token not configured", { status: 503 });
  }

  const signature = c.req.header("x-twilio-signature") ?? "";
  const fullUrl = resolveForwardedUrl(c);
  if (!signature || !(await verifyTwilioSignature(authToken, signature, fullUrl, params))) {
    logger.warn("[twilio-voice-inbound] signature verification failed", {
      url: fullUrl,
    });
    return new Response("Invalid signature", { status: 403 });
  }

  const parsed = TwilioVoicePayloadSchema.safeParse(params);
  if (!parsed.success) {
    logger.warn("[twilio-voice-inbound] invalid payload", {
      errors: parsed.error.format(),
    });
    return new Response("Invalid payload", { status: 400 });
  }

  const event = parsed.data;
  const normalizedFrom = normalizePhoneNumber(event.From);
  const normalizedTo = normalizePhoneNumber(event.To);
  const [phoneNumber] = await dbWrite
    .select({
      agentId: agentPhoneNumbers.agent_id,
      organizationId: agentPhoneNumbers.organization_id,
    })
    .from(agentPhoneNumbers)
    .where(
      and(
        eq(agentPhoneNumbers.phone_number, normalizedTo),
        eq(agentPhoneNumbers.provider, "twilio"),
        eq(agentPhoneNumbers.is_active, true),
        eq(agentPhoneNumbers.can_voice, true),
      ),
    )
    .limit(1);

  const id = randomUUID();
  const rawPayload = await offloadJsonField<Record<string, string>>({
    namespace: ObjectNamespaces.TwilioInboundPayloads,
    organizationId: phoneNumber?.organizationId ?? "twilio",
    objectId: id,
    field: "raw_payload",
    createdAt: new Date(),
    value: params,
    inlineValueWhenOffloaded: {},
  });

  await dbWrite
    .insert(twilioInboundCalls)
    .values({
      id,
      call_sid: event.CallSid,
      account_sid: event.AccountSid,
      from_number: normalizedFrom,
      to_number: normalizedTo,
      call_status: event.CallStatus,
      agent_id: phoneNumber?.agentId ?? null,
      raw_payload: rawPayload.value ?? {},
      raw_payload_storage: rawPayload.storage,
      raw_payload_key: rawPayload.key,
    })
    .onConflictDoNothing({ target: twilioInboundCalls.call_sid });

  logger.info("[twilio-voice-inbound] recorded call", {
    callSid: event.CallSid,
    from: event.From,
    to: event.To,
    status: event.CallStatus,
  });

  return new Response(TWIML_ACK, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
});

export default app;
