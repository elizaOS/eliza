/**
 * Starts authenticated outbound PSTN calls from the public Eliza line and
 * hands answered calls to the same signed realtime voice path used inbound.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { usersRepository } from "@/db/repositories/users";
import { idempotencyKeys, twilioOutboundCalls } from "@/db/schemas";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
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
import { resolveTwilioPublicUrl } from "../lib/twilio-public-url";

const app = new Hono<AppEnv>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

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

interface TwilioCallResponse {
  sid: string;
  status: string;
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
  const auth = await requireUserOrApiKeyWithOrg(c);
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

  const idempotencyDigest = createHash("sha256")
    .update(`${auth.id}:${idempotencyHeader}`)
    .digest("hex");
  const idempotencyKey = `twilio-call:${idempotencyDigest}`;
  let [claim] = await dbWrite
    .insert(idempotencyKeys)
    .values({
      key: idempotencyKey,
      source: "twilio-voice-outbound",
      expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning({ key: idempotencyKeys.key });

  if (!claim) {
    const [existingCall] = await dbWrite
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
    if (existingCall?.callSid) {
      return c.json({
        success: true,
        callId: existingCall.id,
        callSid: existingCall.callSid,
        status: existingCall.status,
        to: maskPhoneNumber(existingCall.to),
        replayed: true,
      });
    }
    if (existingCall) {
      return c.json(
        {
          error: "This call request is already being reconciled",
          code: "duplicate_call_pending",
        },
        409,
      );
    }

    const now = new Date();
    await dbWrite
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, idempotencyKey),
          lt(idempotencyKeys.expires_at, now),
        ),
      );

    [claim] = await dbWrite
      .insert(idempotencyKeys)
      .values({
        key: idempotencyKey,
        source: "twilio-voice-outbound",
        expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing({ target: idempotencyKeys.key })
      .returning({ key: idempotencyKeys.key });

    if (!claim) {
      return c.json(
        {
          error: "This call request was already submitted",
          code: "duplicate_call",
        },
        409,
      );
    }
  }

  const callId = randomUUID();
  await dbWrite.insert(twilioOutboundCalls).values({
    id: callId,
    request_digest: idempotencyDigest,
    account_sid: accountSid,
    organization_id: auth.organization_id,
    user_id: auth.id,
    from_number: fromNumber,
    to_number: requestedPhoneNumber,
    call_status: "requesting",
  });

  let call: TwilioCallResponse;
  try {
    const form = new URLSearchParams();
    form.set("To", requestedPhoneNumber);
    form.set("From", fromNumber);
    form.set("Url", resolveCallbackUrl(c));
    form.set("Method", "POST");
    form.set("StatusCallback", resolveStatusCallbackUrl(c, callId));
    form.set("StatusCallbackMethod", "POST");
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      form.append("StatusCallbackEvent", event);
    }

    call = await twilioApiRequest<TwilioCallResponse>(
      accountSid,
      authToken,
      "POST",
      "/Calls.json",
      form,
    );
  } catch (error) {
    // error-policy:J1 provider failure becomes a boundary response. Retain the
    // claim because Twilio may have accepted the call before the response was
    // lost; replaying the same request could create a duplicate paid call.
    logger.error("[twilio-voice-outbound] failed to queue call", {
      userId: auth.id,
      organizationId: auth.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    await dbWrite
      .update(twilioOutboundCalls)
      .set({
        call_status: "provider-error",
        provider_error_code: "provider_unavailable",
        terminal_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(twilioOutboundCalls.id, callId));
    return c.json(
      { error: "Unable to start the call", code: "provider_unavailable" },
      502,
    );
  }

  let auditPending = false;
  try {
    await dbWrite
      .update(twilioOutboundCalls)
      .set({
        call_sid: call.sid,
        call_status: call.status,
        updated_at: new Date(),
      })
      .where(eq(twilioOutboundCalls.id, callId));
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
