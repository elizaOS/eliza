/** Lets the requesting user inspect or hang up only their own outbound PSTN call. */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { idempotencyKeys, twilioOutboundCalls } from "@/db/schemas";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import { twilioApiRequest } from "@/lib/utils/twilio-api";
import type { AppEnv } from "@/types/cloud-worker-env";
import { isTerminalTwilioCallStatus } from "../../lib/twilio-call-status";

const app = new Hono<AppEnv>();
const CallSid = z.string().regex(/^CA[a-fA-F0-9]{32}$/);
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

interface PublicTwilioEnv {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  ELIZA_APP_TWILIO_ACCOUNT_SID?: string;
  ELIZA_APP_TWILIO_AUTH_TOKEN?: string;
}

function maskPhoneNumber(phoneNumber: string): string {
  return `***${phoneNumber.slice(-4)}`;
}

app.use("*", rateLimit({ ...RateLimitPresets.CRITICAL, failClosed: true }));

async function ownedCall(c: Parameters<typeof requireUserOrApiKeyWithOrg>[0]) {
  const auth = await requireUserOrApiKeyWithOrg(c);
  const parsedSid = CallSid.safeParse(c.req.param("callSid"));
  if (!parsedSid.success) return { auth, call: null };
  const [call] = await dbWrite
    .select()
    .from(twilioOutboundCalls)
    .where(
      and(
        eq(twilioOutboundCalls.call_sid, parsedSid.data),
        eq(twilioOutboundCalls.user_id, auth.id),
        eq(twilioOutboundCalls.organization_id, auth.organization_id),
      ),
    )
    .limit(1);
  return { auth, call: call ?? null };
}

app.get("/", async (c) => {
  const { call } = await ownedCall(c);
  if (!call)
    return c.json({ error: "Call not found", code: "call_not_found" }, 404);
  return c.json({
    success: true,
    callSid: call.call_sid,
    status: call.call_status,
    to: maskPhoneNumber(call.to_number),
    answeredAt: call.answered_at?.toISOString() ?? null,
    terminalAt: call.terminal_at?.toISOString() ?? null,
    hangupRequestedAt: call.hangup_requested_at?.toISOString() ?? null,
  });
});

app.delete("/", async (c) => {
  const { auth, call } = await ownedCall(c);
  if (!call?.call_sid) {
    return c.json({ error: "Call not found", code: "call_not_found" }, 404);
  }
  if (isTerminalTwilioCallStatus(call.call_status)) {
    return c.json({
      success: true,
      callSid: call.call_sid,
      status: call.call_status,
      alreadyTerminal: true,
    });
  }

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
  const digest = createHash("sha256")
    .update(`${auth.id}:${call.call_sid}:${idempotencyHeader}`)
    .digest("hex");
  const idempotencyKey = `twilio-hangup:${digest}`;

  const env = c.env as unknown as PublicTwilioEnv;
  const authToken = (
    env.TWILIO_AUTH_TOKEN ?? env.ELIZA_APP_TWILIO_AUTH_TOKEN
  )?.trim();
  const accountSid = (
    env.TWILIO_ACCOUNT_SID ?? env.ELIZA_APP_TWILIO_ACCOUNT_SID
  )?.trim();
  if (!authToken || !accountSid || accountSid !== call.account_sid) {
    return c.json(
      {
        error: "Eliza calling is not configured",
        code: "voice_not_configured",
      },
      503,
    );
  }

  const [claim] = await dbWrite
    .insert(idempotencyKeys)
    .values({
      key: idempotencyKey,
      source: "twilio-voice-hangup",
      expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning({ key: idempotencyKeys.key });
  if (!claim) {
    return c.json({
      success: true,
      callSid: call.call_sid,
      status: call.call_status,
      replayed: true,
    });
  }

  const form = new URLSearchParams({ Status: "completed" });
  try {
    await twilioApiRequest(
      accountSid,
      authToken,
      "POST",
      `/Calls/${encodeURIComponent(call.call_sid)}.json`,
      form,
    );
  } catch (error) {
    // error-policy:J1 ending the same Twilio CallSid is provider-idempotent, so
    // release this exact claim and let the user's same explicit click retry.
    logger.error("[twilio-voice-outbound] failed to request hangup", {
      callSid: call.call_sid,
      userId: auth.id,
      organizationId: auth.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    await dbWrite
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idempotencyKey));
    return c.json(
      { error: "Unable to hang up the call", code: "provider_unavailable" },
      502,
    );
  }

  await dbWrite
    .update(twilioOutboundCalls)
    .set({
      call_status: "hangup-requested",
      hangup_requested_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(twilioOutboundCalls.id, call.id));
  return c.json({
    success: true,
    callSid: call.call_sid,
    status: "hangup-requested",
  });
});

export default app;
