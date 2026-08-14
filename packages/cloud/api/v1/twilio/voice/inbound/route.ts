/**
 * Authenticates Twilio voice webhooks, records each call, resolves its Eliza
 * agent, and returns TwiML that connects the PSTN audio to the realtime stream.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead, dbWrite } from "@/db/helpers";
import { twilioInboundCalls } from "@/db/schemas";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { offloadJsonField } from "@/lib/storage/object-store";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import { verifyTwilioSignature } from "@/lib/utils/twilio-api";
import { recordVoiceSessionJti } from "@/lib/voice-session/jwt";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { scheduleTwilioVoiceScopePrewarm } from "../lib/prewarm-voice-scope";
import { resolveTwilioVoiceTarget } from "../lib/resolve-voice-target";
import { mintTwilioStreamToken } from "../lib/twilio-stream-token";
import {
  buildRealtimeVoiceTwiML,
  buildTerminalVoiceTwiML,
} from "../lib/twilio-voice-twiml";

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

const NOT_CONFIGURED_PROMPT =
  "This phone number is not configured for Eliza voice yet. Please check the Eliza Cloud control panel.";

function resolvePublicUrl(c: AppContext): URL {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  if (forwardedHost) url.host = forwardedHost;
  const configured = (c.env.TWILIO_PUBLIC_URL as string | undefined)?.trim();
  if (configured) {
    const publicBase = new URL(configured);
    url.protocol = publicBase.protocol;
    url.host = publicBase.host;
  }
  return url;
}

app.post("/", async (c) => {
  const rawBody = await c.req.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
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
  const telephonyEnv = c.env as unknown as {
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    ELIZA_APP_TWILIO_ACCOUNT_SID?: string;
    ELIZA_APP_TWILIO_AUTH_TOKEN?: string;
  };
  const authToken = (
    telephonyEnv.TWILIO_AUTH_TOKEN ?? telephonyEnv.ELIZA_APP_TWILIO_AUTH_TOKEN
  )?.trim();
  if (!authToken) {
    logger.warn(
      "[twilio-voice-inbound] auth token not configured; refusing call",
    );
    return new Response("Twilio auth token not configured", { status: 503 });
  }
  const expectedAccountSid = (
    telephonyEnv.TWILIO_ACCOUNT_SID ?? telephonyEnv.ELIZA_APP_TWILIO_ACCOUNT_SID
  )?.trim();
  if (expectedAccountSid && event.AccountSid !== expectedAccountSid) {
    logger.warn("[twilio-voice-inbound] account SID mismatch");
    return new Response("Invalid account", { status: 403 });
  }

  const publicUrl = resolvePublicUrl(c);
  const signature = c.req.header("x-twilio-signature") ?? "";
  if (
    !(await verifyTwilioSignature(
      authToken,
      signature,
      publicUrl.toString(),
      params,
    ))
  ) {
    logger.warn("[twilio-voice-inbound] signature verification failed", {
      url: publicUrl.toString(),
    });
    return new Response("Invalid signature", { status: 403 });
  }

  const phoneNumber = await resolveTwilioVoiceTarget(c.env, normalizedTo);
  if (!phoneNumber) {
    return new Response(buildTerminalVoiceTwiML(NOT_CONFIGURED_PROMPT), {
      headers: { "Content-Type": "text/xml" },
    });
  }

  const id = randomUUID();
  const conversationId = randomUUID();
  try {
    scheduleTwilioVoiceScopePrewarm({
      agent: phoneNumber.agent,
      env: c.env,
      executionCtx: c.executionCtx,
      claims: {
        agentId: phoneNumber.agentId,
        conversationId,
        organizationId: phoneNumber.organizationId,
        userId: phoneNumber.userId,
      },
    });
  } catch (error) {
    // error-policy:J7 local/test contexts can omit a Worker execution context;
    // the media session remains the authoritative cold-hydration boundary.
    logger.warn("[twilio-voice-inbound] early scope prewarm unavailable", {
      agentId: phoneNumber.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const [priorCall] = await dbRead
    .select({ id: twilioInboundCalls.id })
    .from(twilioInboundCalls)
    .where(
      and(
        eq(twilioInboundCalls.from_number, normalizedFrom),
        eq(twilioInboundCalls.to_number, normalizedTo),
        eq(twilioInboundCalls.agent_id, phoneNumber.agentId),
      ),
    )
    .limit(1);
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

  logger.info("[twilio-voice-inbound] recorded realtime call", {
    callSid: event.CallSid,
    from: normalizedFrom,
    to: normalizedTo,
    agentId: phoneNumber?.agentId,
  });

  const minted = await mintTwilioStreamToken(
    {
      accountSid: event.AccountSid,
      callSid: event.CallSid,
      organizationId: phoneNumber.organizationId,
      userId: phoneNumber.userId,
      agentId: phoneNumber.agentId,
      conversationId,
      calledNumber: normalizedTo,
      returningCaller: Boolean(priorCall),
    },
    authToken,
  );
  await recordVoiceSessionJti({
    organizationId: phoneNumber.organizationId,
    userId: phoneNumber.userId,
    sessionId: minted.claims.sessionId,
    jti: minted.claims.jti,
    expSeconds: minted.claims.exp,
  });
  publicUrl.pathname = "/api/v1/twilio/voice/media";
  publicUrl.search = "";
  publicUrl.protocol = publicUrl.protocol === "http:" ? "ws:" : "wss:";
  return new Response(
    buildRealtimeVoiceTwiML({
      streamUrl: publicUrl.toString(),
      sessionId: minted.claims.sessionId,
      token: minted.token,
    }),
    {
      headers: { "Content-Type": "text/xml" },
    },
  );
});

export default app;
