/**
 * Authenticates Twilio voice webhooks, records each call, resolves its Eliza
 * agent, and returns TwiML that connects the PSTN audio to the realtime stream.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead, dbWrite } from "@/db/helpers";
import { sharedRuntimeHistory, twilioInboundCalls } from "@/db/schemas";
import { appendServerTiming } from "@/lib/observability/http-telemetry";
import { sharedRuntimeChannelId } from "@/lib/services/shared-runtime/shared-runtime-chat";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { offloadJsonField } from "@/lib/storage/object-store";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import { verifyTwilioSignature } from "@/lib/utils/twilio-api";
import { recordVoiceSessionJti } from "@/lib/voice-session/jwt";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { scheduleTwilioVoiceScopePrewarm } from "../lib/prewarm-voice-scope";
import { resolveTwilioVoiceTarget } from "../lib/resolve-voice-target";
import { resolveTwilioCallParticipants } from "../lib/twilio-call-direction";
import {
  mintTwilioStreamToken,
  prepareTwilioStreamToken,
} from "../lib/twilio-stream-token";
import {
  buildRealtimeVoiceTwiML,
  buildTerminalVoiceTwiML,
} from "../lib/twilio-voice-twiml";
import {
  claimInboundCallOpeningContext,
  type InboundCallOpeningClaim,
  resolveCallContinuityContext,
} from "../lib/voice-continuity";

const app = new Hono<AppEnv>();

const TwilioVoicePayloadSchema = z
  .object({
    CallSid: z.string().min(1),
    AccountSid: z.string().min(1),
    From: z.string().min(1),
    To: z.string().min(1),
    CallStatus: z.string().min(1),
    Direction: z.string().optional(),
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
  const requestStartedAt = Date.now();
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
  const { publicLineNumber, callerNumber } = resolveTwilioCallParticipants({
    direction: event.Direction,
    from: normalizedFrom,
    to: normalizedTo,
  });
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

  const phoneNumber = await resolveTwilioVoiceTarget(
    c.env,
    publicLineNumber,
    callerNumber,
  );
  if (!phoneNumber) {
    return new Response(buildTerminalVoiceTwiML(NOT_CONFIGURED_PROMPT), {
      headers: { "Content-Type": "text/xml" },
    });
  }
  const targetResolvedAt = Date.now();

  const proposedCallId = randomUUID();
  const conversationId = phoneNumber.agentId;
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
  const tokenBootstrap = prepareTwilioStreamToken();
  const sessionDirectoryStartedAt = Date.now();
  const sessionDirectoryPromise = recordVoiceSessionJti({
    organizationId: phoneNumber.organizationId,
    userId: phoneNumber.userId,
    sessionId: tokenBootstrap.sessionId,
    jti: tokenBootstrap.jti,
    expSeconds: tokenBootstrap.exp,
  }).then(() => Date.now());
  // The opening context (returning-caller flag + prior-interaction time) is
  // claimed once per CallSid and frozen for the rest of the call: without this,
  // a slow-resolving lookup racing later writes could flip the greeting mid-call.
  const [existingCall] = await dbWrite
    .select({
      id: twilioInboundCalls.id,
      receivedAt: twilioInboundCalls.received_at,
      returningCaller: twilioInboundCalls.opening_returning_caller,
      previousInteractionAt: twilioInboundCalls.opening_previous_interaction_at,
    })
    .from(twilioInboundCalls)
    .where(eq(twilioInboundCalls.call_sid, event.CallSid))
    .limit(1);
  const candidateReceivedAt =
    existingCall?.receivedAt ?? new Date(requestStartedAt);
  const candidateCallStartedAt = candidateReceivedAt.getTime();
  let callOpening: InboundCallOpeningClaim;
  if (existingCall && existingCall.returningCaller !== null) {
    callOpening = {
      id: existingCall.id,
      receivedAt: existingCall.receivedAt,
      returningCaller: existingCall.returningCaller,
      previousInteractionAt:
        existingCall.previousInteractionAt?.getTime() ?? undefined,
    };
  } else {
    const priorCallPromise = Promise.resolve(
      dbRead
        .select({
          id: twilioInboundCalls.id,
          receivedAt: twilioInboundCalls.received_at,
        })
        .from(twilioInboundCalls)
        .where(
          and(
            or(
              and(
                eq(twilioInboundCalls.from_number, callerNumber),
                eq(twilioInboundCalls.to_number, publicLineNumber),
              ),
              and(
                eq(twilioInboundCalls.from_number, publicLineNumber),
                eq(twilioInboundCalls.to_number, callerNumber),
              ),
            ),
            eq(twilioInboundCalls.agent_id, phoneNumber.agentId),
            ne(twilioInboundCalls.call_sid, event.CallSid),
            lt(twilioInboundCalls.received_at, candidateReceivedAt),
          ),
        )
        .orderBy(desc(twilioInboundCalls.received_at))
        .limit(1),
    );
    const priorConversationPromise = Promise.resolve(
      dbRead
        .select({ messages: sharedRuntimeHistory.messages })
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, phoneNumber.agentId),
            eq(
              sharedRuntimeHistory.channel_id,
              sharedRuntimeChannelId(phoneNumber.agentId, conversationId),
            ),
          ),
        )
        .orderBy(desc(sharedRuntimeHistory.updated_at))
        .limit(1),
    );
    const [[priorCall], [priorConversation]] = await Promise.all([
      priorCallPromise,
      priorConversationPromise,
    ]);
    const candidateContinuity = resolveCallContinuityContext({
      callStartedAt: candidateCallStartedAt,
      ...(priorCall?.receivedAt
        ? { priorCallAt: priorCall.receivedAt.getTime() }
        : {}),
      historyMessages: priorConversation ? priorConversation.messages : [],
    });
    callOpening = await claimInboundCallOpeningContext(
      {
        id: existingCall?.id ?? proposedCallId,
        receivedAt: candidateReceivedAt,
        ...candidateContinuity,
      },
      async (candidate) => {
        const [claimed] = await dbWrite
          .insert(twilioInboundCalls)
          .values({
            id: candidate.id,
            call_sid: event.CallSid,
            account_sid: event.AccountSid,
            from_number: normalizedFrom,
            to_number: normalizedTo,
            call_status: event.CallStatus,
            agent_id: phoneNumber.agentId,
            raw_payload: {},
            opening_returning_caller: candidate.returningCaller,
            opening_previous_interaction_at:
              candidate.previousInteractionAt === undefined
                ? null
                : new Date(candidate.previousInteractionAt),
            received_at: candidate.receivedAt,
          })
          .onConflictDoUpdate({
            target: twilioInboundCalls.call_sid,
            // Both expressions read the pre-update row so a losing candidate's
            // timestamp can never mix with the winning returning-caller flag.
            set: {
              opening_previous_interaction_at: sql<Date | null>`CASE
              WHEN ${twilioInboundCalls.opening_returning_caller} IS NULL
                THEN EXCLUDED."opening_previous_interaction_at"
              ELSE ${twilioInboundCalls.opening_previous_interaction_at}
            END`,
              opening_returning_caller: sql<boolean>`COALESCE(
              ${twilioInboundCalls.opening_returning_caller},
              EXCLUDED."opening_returning_caller"
            )`,
            },
          })
          .returning({
            id: twilioInboundCalls.id,
            receivedAt: twilioInboundCalls.received_at,
            returningCaller: twilioInboundCalls.opening_returning_caller,
            previousInteractionAt:
              twilioInboundCalls.opening_previous_interaction_at,
          });
        if (!claimed || claimed.returningCaller === null) return undefined;
        return {
          id: claimed.id,
          receivedAt: claimed.receivedAt,
          returningCaller: claimed.returningCaller,
          previousInteractionAt:
            claimed.previousInteractionAt?.getTime() ?? undefined,
        };
      },
    );
  }
  const callStartedAt = callOpening.receivedAt.getTime();
  const rawPayloadPromise = offloadJsonField<Record<string, string>>({
    namespace: ObjectNamespaces.TwilioInboundPayloads,
    organizationId: phoneNumber.organizationId,
    objectId: callOpening.id,
    field: "raw_payload",
    createdAt: callOpening.receivedAt,
    value: params,
    inlineValueWhenOffloaded: {},
  });
  const recordCallPayload = rawPayloadPromise
    .then((rawPayload) =>
      dbWrite
        .update(twilioInboundCalls)
        .set({
          call_status: event.CallStatus,
          raw_payload: rawPayload.value ?? {},
          raw_payload_storage: rawPayload.storage,
          raw_payload_key: rawPayload.key,
        })
        .where(eq(twilioInboundCalls.id, callOpening.id)),
    )
    .then(() => {
      logger.info("[twilio-voice-inbound] recorded realtime call payload", {
        callSid: event.CallSid,
        from: normalizedFrom,
        to: normalizedTo,
        agentId: phoneNumber.agentId,
        persistenceMs: Date.now() - requestStartedAt,
      });
    })
    .catch((error) => {
      // error-policy:J7 the identity row already protects idempotency; raw
      // provider-envelope offload is diagnostic and must not delay TwiML.
      logger.warn("[twilio-voice-inbound] call payload persistence failed", {
        callSid: event.CallSid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  try {
    c.executionCtx.waitUntil(recordCallPayload);
  } catch (error) {
    // error-policy:J7 a local/test context may lack a Worker lifetime; the
    // already-contained persistence promise remains best-effort in-process.
    logger.warn("[twilio-voice-inbound] call persistence wait unavailable", {
      callSid: event.CallSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // callOpening above already resolved the caller-history lookup (directly, or
  // via the claim's prior-call/prior-conversation queries); this timestamp is
  // this request's stand-in for that resolution so the parallel-setup timing
  // below still reflects how much of the session-directory write overlapped it.
  const callerHistoryResolvedAt = Date.now();
  const sessionDirectoryResolvedAt = await sessionDirectoryPromise;
  const parallelSetupResolvedAt = Math.max(
    callerHistoryResolvedAt,
    sessionDirectoryResolvedAt,
  );
  const minted = await mintTwilioStreamToken(
    {
      accountSid: event.AccountSid,
      callSid: event.CallSid,
      organizationId: phoneNumber.organizationId,
      userId: phoneNumber.userId,
      agentId: phoneNumber.agentId,
      conversationId,
      calledNumber: publicLineNumber,
      returningCaller: callOpening.returningCaller,
      previousInteractionAt: callOpening.previousInteractionAt,
      callStartedAt,
    },
    authToken,
    Date.now,
    tokenBootstrap,
  );
  const responseReadyAt = Date.now();
  logger.info("[twilio-voice-inbound] realtime TwiML ready", {
    callSid: event.CallSid,
    returningCaller: callOpening.returningCaller,
    targetResolution: phoneNumber.resolution,
    targetMs: targetResolvedAt - requestStartedAt,
    callerLookupMs: callerHistoryResolvedAt - targetResolvedAt,
    sessionDirectoryMs: sessionDirectoryResolvedAt - sessionDirectoryStartedAt,
    setupOverlapMs:
      Math.min(callerHistoryResolvedAt, sessionDirectoryResolvedAt) -
      sessionDirectoryStartedAt,
    parallelSetupMs: parallelSetupResolvedAt - targetResolvedAt,
    tokenMs: responseReadyAt - parallelSetupResolvedAt,
    totalMs: responseReadyAt - requestStartedAt,
  });
  publicUrl.pathname = "/api/v1/twilio/voice/media";
  publicUrl.search = "";
  publicUrl.protocol = publicUrl.protocol === "http:" ? "ws:" : "wss:";
  const response = new Response(
    buildRealtimeVoiceTwiML({
      streamUrl: publicUrl.toString(),
      sessionId: minted.claims.sessionId,
      token: minted.token,
    }),
    {
      headers: { "Content-Type": "text/xml" },
    },
  );
  appendServerTiming(response.headers, [
    {
      name: "voice_target",
      durationMs: targetResolvedAt - requestStartedAt,
      description: phoneNumber.resolution,
    },
    {
      name: "voice_caller_history",
      durationMs: callerHistoryResolvedAt - targetResolvedAt,
    },
    {
      name: "voice_session_directory",
      durationMs: sessionDirectoryResolvedAt - sessionDirectoryStartedAt,
    },
    {
      name: "voice_token",
      durationMs: responseReadyAt - parallelSetupResolvedAt,
    },
  ]);
  return response;
});

export default app;
