/**
 * Starts authenticated outbound PSTN calls from the public Eliza line and
 * hands answered calls to the same signed realtime voice path used inbound.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError, isElizaError } from "@elizaos/core/edge";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite, writeTransaction } from "@/db/helpers";
import { usersRepository } from "@/db/repositories/users";
import { idempotencyKeys, twilioOutboundCalls } from "@/db/schemas";
import { requireSessionUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import {
  isValidE164,
  normalizePhoneNumber,
} from "@/lib/utils/phone-normalization";
import { twilioApiRequest } from "@/lib/utils/twilio-api";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import {
  TWILIO_CALL_FENCE_EXPIRY,
  twilioCallFenceKey,
  twilioCallFenceSource,
} from "../lib/twilio-call-fence";
import { normalizeTwilioProviderCallStatus } from "../lib/twilio-call-status";
import { resolveTwilioPublicUrl } from "../lib/twilio-public-url";

const app = new Hono<AppEnv>();

const StartCallBody = z.object({
  to: z.string().min(1).max(32).optional(),
});

interface PublicTwilioEnv {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PUBLIC_URL?: string;
  ELIZA_APP_TWILIO_ACCOUNT_SID?: string;
  ELIZA_APP_TWILIO_AUTH_TOKEN?: string;
  ELIZA_APP_TWILIO_PHONE_NUMBER?: string;
}

const TwilioCallResponse = z.object({
  sid: z.string().regex(/^CA[a-fA-F0-9]{32}$/),
  status: z.string().transform((status, context) => {
    const normalized = normalizeTwilioProviderCallStatus(status);
    if (normalized) return normalized;
    context.addIssue({ code: "custom", message: "Invalid Twilio call status" });
    return z.NEVER;
  }),
});

interface ExistingCall {
  id: string;
  callSid: string | null;
  status: string;
  to: string;
}

function resolveCallbackUrl(c: AppContext): string {
  const url = resolveTwilioPublicUrl(c, "/api/v1/twilio/voice/inbound");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveStatusCallbackUrl(c: AppContext, requestId: string): string {
  const url = resolveTwilioPublicUrl(c, "/api/v1/twilio/voice/status");
  url.search = new URLSearchParams({ requestId }).toString();
  url.hash = "";
  return url.toString();
}

function maskPhoneNumber(phoneNumber: string): string {
  return `***${phoneNumber.slice(-4)}`;
}

app.use(
  "*",
  rateLimit({
    ...RateLimitPresets.CRITICAL,
    failClosed: true,
  }),
);

app.post("/", async (c) => {
  const auth = await requireSessionUserWithOrg(c);
  const idempotencyHeader = c.req.header("Idempotency-Key")?.trim();
  if (!idempotencyHeader || idempotencyHeader.length > 128) {
    return c.json(
      {
        error: "A valid Idempotency-Key header is required",
        code: "idempotency_key_required",
      },
      400,
    );
  }

  const decodedBody = await decodeRequestJson(c.req);
  if (!decodedBody.ok) {
    // error-policy:J3 malformed JSON is rejected instead of becoming an empty call request.
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }
  const rawBody = decodedBody.value;
  const parsed = StartCallBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid call request", code: "invalid_request" },
      400,
    );
  }

  const user = await usersRepository.findById(auth.id);
  if (!user?.phone_number || user.phone_verified !== true) {
    return c.json(
      {
        error:
          "Verify a phone number on your Eliza account before requesting a call",
        code: "phone_verification_required",
      },
      409,
    );
  }

  const verifiedPhoneNumber = normalizePhoneNumber(user.phone_number);
  const requestedPhoneNumber = normalizePhoneNumber(
    parsed.data.to ?? verifiedPhoneNumber,
  );
  if (!isValidE164(requestedPhoneNumber)) {
    return c.json(
      { error: "Phone number must use E.164 format", code: "invalid_phone" },
      400,
    );
  }
  if (requestedPhoneNumber !== verifiedPhoneNumber) {
    return c.json(
      {
        error: "Calls can only be placed to your verified account phone number",
        code: "phone_not_verified",
      },
      403,
    );
  }

  const env = c.env as unknown as PublicTwilioEnv;
  const accountSid = (
    env.TWILIO_ACCOUNT_SID ?? env.ELIZA_APP_TWILIO_ACCOUNT_SID
  )?.trim();
  const authToken = (
    env.TWILIO_AUTH_TOKEN ?? env.ELIZA_APP_TWILIO_AUTH_TOKEN
  )?.trim();
  const fromNumber = normalizePhoneNumber(
    env.ELIZA_APP_TWILIO_PHONE_NUMBER ?? "",
  );
  if (!accountSid || !authToken || !isValidE164(fromNumber)) {
    return c.json(
      {
        error: "Eliza calling is not configured",
        code: "voice_not_configured",
      },
      503,
    );
  }

  const callId = randomUUID();
  let callbackUrl: string;
  let statusCallbackUrl: string;
  try {
    callbackUrl = resolveCallbackUrl(c);
    statusCallbackUrl = resolveStatusCallbackUrl(c, callId);
  } catch (error) {
    // error-policy:J1 invalid server-owned callback configuration is known
    // before provider dispatch and becomes an explicit unavailable response.
    logger.error("[twilio-voice-outbound] public callback origin is invalid", {
      errorCode: isElizaError(error) ? error.code : "TWILIO_PUBLIC_URL_INVALID",
    });
    return c.json(
      {
        error: "Eliza calling callback origin is not configured",
        code: "voice_not_configured",
      },
      503,
    );
  }

  const idempotencyDigest = createHash("sha256")
    .update(`${auth.id}:${idempotencyHeader}`)
    .digest("hex");
  const fenceKey = twilioCallFenceKey(
    auth.organization_id,
    auth.id,
    requestedPhoneNumber,
  );
  const admission = await writeTransaction(async (tx) => {
    const [exactCall] = await tx
      .select({
        id: twilioOutboundCalls.id,
        callSid: twilioOutboundCalls.call_sid,
        status: twilioOutboundCalls.call_status,
        to: twilioOutboundCalls.to_number,
      })
      .from(twilioOutboundCalls)
      .where(
        and(
          eq(twilioOutboundCalls.request_digest, idempotencyDigest),
          eq(twilioOutboundCalls.user_id, auth.id),
          eq(twilioOutboundCalls.organization_id, auth.organization_id),
        ),
      )
      .limit(1);
    if (exactCall) return { existingCall: exactCall };

    let [fenceClaim] = await tx
      .insert(idempotencyKeys)
      .values({
        key: fenceKey,
        source: twilioCallFenceSource(callId),
        expires_at: TWILIO_CALL_FENCE_EXPIRY,
      })
      .onConflictDoNothing({ target: idempotencyKeys.key })
      .returning({ key: idempotencyKeys.key });

    if (!fenceClaim) {
      const [unresolvedCall] = await tx
        .select({
          id: twilioOutboundCalls.id,
          callSid: twilioOutboundCalls.call_sid,
          status: twilioOutboundCalls.call_status,
          to: twilioOutboundCalls.to_number,
        })
        .from(twilioOutboundCalls)
        .where(
          and(
            eq(twilioOutboundCalls.organization_id, auth.organization_id),
            eq(twilioOutboundCalls.user_id, auth.id),
            eq(twilioOutboundCalls.to_number, requestedPhoneNumber),
            inArray(twilioOutboundCalls.call_status, [
              "requesting",
              "submission-unknown",
            ]),
          ),
        )
        .limit(1);
      if (unresolvedCall) return { existingCall: unresolvedCall };

      // A validated provider receipt or signed callback normally clears the
      // fence. Recover a stale fence only after proving no unresolved call owns it.
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.key, fenceKey));
      [fenceClaim] = await tx
        .insert(idempotencyKeys)
        .values({
          key: fenceKey,
          source: twilioCallFenceSource(callId),
          expires_at: TWILIO_CALL_FENCE_EXPIRY,
        })
        .onConflictDoNothing({ target: idempotencyKeys.key })
        .returning({ key: idempotencyKeys.key });
      if (!fenceClaim) return { existingCall: null };
    }

    await tx.insert(twilioOutboundCalls).values({
      id: callId,
      request_digest: idempotencyDigest,
      account_sid: accountSid,
      organization_id: auth.organization_id,
      user_id: auth.id,
      from_number: fromNumber,
      to_number: requestedPhoneNumber,
      call_status: "requesting",
    });
    return { callId };
  });

  if ("existingCall" in admission) {
    const existingCall: ExistingCall | null = admission.existingCall ?? null;
    if (!existingCall) {
      return c.json(
        {
          error: "Another call request is being admitted",
          code: "duplicate_call_pending",
        },
        409,
      );
    }
    return c.json(
      {
        success: true,
        callId: existingCall.id,
        callSid: existingCall.callSid,
        status: existingCall.status,
        to: maskPhoneNumber(existingCall.to),
        replayed: true,
      },
      existingCall.callSid ? 200 : 202,
    );
  }

  let call: z.infer<typeof TwilioCallResponse>;
  try {
    const form = new URLSearchParams();
    form.set("To", requestedPhoneNumber);
    form.set("From", fromNumber);
    form.set("Url", callbackUrl);
    form.set("Method", "POST");
    form.set("StatusCallback", statusCallbackUrl);
    form.set("StatusCallbackMethod", "POST");
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      form.append("StatusCallbackEvent", event);
    }

    const rawCall = await twilioApiRequest<unknown>(
      accountSid,
      authToken,
      "POST",
      "/Calls.json",
      form,
    );
    const parsedCall = TwilioCallResponse.safeParse(rawCall);
    if (!parsedCall.success) {
      throw new ElizaError("Twilio accepted the call without a valid receipt", {
        code: "TWILIO_RECEIPT_INVALID",
        context: { callId, provider: "twilio" },
        cause: parsedCall.error,
        severity: "fatal",
      });
    }
    call = parsedCall.data;
  } catch (error) {
    const providerRejected =
      isElizaError(error) && error.code === "TWILIO_PROVIDER_REJECTED";
    logger.error("[twilio-voice-outbound] failed to queue call", {
      userId: auth.id,
      organizationId: auth.organization_id,
      errorCode: isElizaError(error)
        ? error.code
        : "TWILIO_SUBMISSION_UNCERTAIN",
      error: error instanceof Error ? error.message : String(error),
    });
    if (providerRejected) {
      // error-policy:J1 an explicit provider 4xx proves the paid call was not
      // accepted, so the boundary may terminalize and release the global fence.
      await writeTransaction(async (tx) => {
        await tx
          .update(twilioOutboundCalls)
          .set({
            call_status: "provider-error",
            provider_error_code: error.code,
            terminal_at: new Date(),
            updated_at: new Date(),
          })
          .where(
            and(
              eq(twilioOutboundCalls.id, callId),
              lt(twilioOutboundCalls.last_status_sequence, 0),
              eq(twilioOutboundCalls.call_status, "requesting"),
            ),
          );
        await tx
          .delete(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.key, fenceKey),
              eq(idempotencyKeys.source, twilioCallFenceSource(callId)),
            ),
          );
      });
      const providerStatus =
        typeof error.context?.providerStatus === "number"
          ? error.context.providerStatus
          : undefined;
      return c.json(
        {
          error: "Twilio rejected the call request",
          code: "provider_rejected",
          ...(providerStatus === undefined ? {} : { providerStatus }),
        },
        providerStatus === 429 ? 429 : 502,
      );
    }

    // error-policy:J4 a missing or unusable provider response cannot prove
    // rejection. Retain the fence and expose the durable call id so signed
    // callbacks can reconcile an accepted call without authorizing a retry.
    await dbWrite
      .update(twilioOutboundCalls)
      .set({
        call_status: "submission-unknown",
        provider_error_code: isElizaError(error)
          ? error.code
          : "TWILIO_SUBMISSION_UNCERTAIN",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(twilioOutboundCalls.id, callId),
          lt(twilioOutboundCalls.last_status_sequence, 0),
          eq(twilioOutboundCalls.call_status, "requesting"),
        ),
      );
    return c.json(
      {
        success: true,
        callId,
        callSid: null,
        status: "submission-unknown",
        to: maskPhoneNumber(requestedPhoneNumber),
        auditPending: true,
      },
      202,
    );
  }

  let auditPending = false;
  try {
    await writeTransaction(async (tx) => {
      await tx
        .update(twilioOutboundCalls)
        .set({
          call_sid: call.sid,
          call_status: sql`CASE
            WHEN ${twilioOutboundCalls.last_status_sequence} < 0 THEN ${call.status}
            ELSE ${twilioOutboundCalls.call_status}
          END`,
          updated_at: new Date(),
        })
        .where(eq(twilioOutboundCalls.id, callId));
      await tx
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.key, fenceKey),
            eq(idempotencyKeys.source, twilioCallFenceSource(callId)),
          ),
        );
    });
  } catch (error) {
    // error-policy:J4 Twilio accepted the call; the signed callback keyed by
    // callId remains the authoritative reconciliation path for this row.
    auditPending = true;
    logger.error(
      "[twilio-voice-outbound] queued call awaiting callback reconciliation",
      {
        callSid: call.sid,
        callId,
        userId: auth.id,
        organizationId: auth.organization_id,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  logger.info("[twilio-voice-outbound] call queued", {
    callSid: call.sid,
    callId,
    userId: auth.id,
    organizationId: auth.organization_id,
    to: maskPhoneNumber(requestedPhoneNumber),
  });
  return c.json(
    {
      success: true,
      callId,
      callSid: call.sid,
      status: call.status,
      to: maskPhoneNumber(requestedPhoneNumber),
      ...(auditPending ? { auditPending: true } : {}),
    },
    auditPending ? 202 : 200,
  );
});

export default app;
