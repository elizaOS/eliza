/**
 * Starts authenticated outbound PSTN calls from the public Eliza line and
 * hands answered calls to the same signed realtime voice path used inbound.
 */

import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { usersRepository } from "@/db/repositories/users";
import { idempotencyKeys } from "@/db/schemas";
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

function resolveCallbackUrl(c: AppContext, configured?: string): string {
  const url = new URL(configured?.trim() || c.req.url);
  url.pathname = "/api/v1/twilio/voice/inbound";
  url.search = "";
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

  try {
    const form = new URLSearchParams();
    form.set("To", requestedPhoneNumber);
    form.set("From", fromNumber);
    form.set("Url", resolveCallbackUrl(c, env.TWILIO_PUBLIC_URL));
    form.set("Method", "POST");

    const call = await twilioApiRequest<TwilioCallResponse>(
      accountSid,
      authToken,
      "POST",
      "/Calls.json",
      form,
    );
    logger.info("[twilio-voice-outbound] call queued", {
      callSid: call.sid,
      userId: auth.id,
      organizationId: auth.organization_id,
      to: maskPhoneNumber(requestedPhoneNumber),
    });
    return c.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      to: maskPhoneNumber(requestedPhoneNumber),
    });
  } catch (error) {
    // error-policy:J1 provider failure becomes a boundary response. Retain the
    // claim because Twilio may have accepted the call before the response was
    // lost; replaying the same request could create a duplicate paid call.
    logger.error("[twilio-voice-outbound] failed to queue call", {
      userId: auth.id,
      organizationId: auth.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { error: "Unable to start the call", code: "provider_unavailable" },
      502,
    );
  }
});

export default app;
