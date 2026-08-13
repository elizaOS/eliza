/**
 * Starts authenticated outbound Eliza calls through Twilio and connects the
 * answered PSTN leg to the same bidirectional Cartesia realtime media stream.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead } from "@/db/helpers";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { agentPhoneNumbers } from "@/db/schemas";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import { isE164PhoneNumber, twilioApiRequest } from "@/lib/utils/twilio-api";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { buildRealtimeVoiceTwiML } from "../lib/twilio-voice-twiml";

const app = new Hono<AppEnv>();

const OutboundCallSchema = z.object({
  agentId: z.string().uuid(),
  to: z.string().refine(isE164PhoneNumber, "to must be an E.164 phone number"),
  conversationId: z.string().uuid().optional(),
});

interface TwilioCallResponse {
  sid: string;
  status: string;
  to: string;
  from: string;
}

function mediaStreamUrl(c: AppContext): string {
  const configured = (c.env.TWILIO_PUBLIC_URL as string | undefined)?.trim();
  const url = new URL(configured || c.req.url);
  url.pathname = "/api/v1/twilio/voice/media";
  url.search = "";
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

app.post("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  let requestBody: unknown;
  try {
    requestBody = await c.req.json();
  } catch {
    // error-policy:J3 malformed JSON is explicit invalid input, never a
    // defaulted call request.
    return c.json({ error: "invalid outbound call request" }, 400);
  }
  const parsed = OutboundCallSchema.safeParse(requestBody);
  if (!parsed.success) {
    return c.json(
      { error: "invalid outbound call request", issues: parsed.error.issues },
      400,
    );
  }

  const sandbox = await agentSandboxesRepository.findByIdAndOrg(
    parsed.data.agentId,
    user.organization_id,
  );
  if (!sandbox || sandbox.user_id !== user.id) {
    return c.json({ error: "agent not found", code: "agent_not_found" }, 404);
  }
  const [mapping] = await dbRead
    .select({ phoneNumber: agentPhoneNumbers.phone_number })
    .from(agentPhoneNumbers)
    .where(
      and(
        eq(agentPhoneNumbers.agent_id, sandbox.id),
        eq(agentPhoneNumbers.organization_id, user.organization_id),
        eq(agentPhoneNumbers.provider, "twilio"),
        eq(agentPhoneNumbers.is_active, true),
        eq(agentPhoneNumbers.can_voice, true),
      ),
    )
    .limit(1);
  if (!mapping) {
    return c.json({ error: "agent has no active Twilio voice number" }, 409);
  }

  const [accountSid, authToken] = await Promise.all([
    twilioAutomationService.getAccountSid(user.organization_id),
    twilioAutomationService.getAuthToken(user.organization_id),
  ]);
  if (!accountSid || !authToken) {
    return c.json(
      { error: "Twilio is not connected for this organization" },
      409,
    );
  }

  const configuredCallerId = (
    c.env as unknown as { TWILIO_VOICE_CALLER_ID?: string }
  ).TWILIO_VOICE_CALLER_ID?.trim();
  const from = configuredCallerId || mapping.phoneNumber;
  if (!isE164PhoneNumber(from)) {
    logger.error("[twilio-voice-calls] configured caller ID is invalid");
    return c.json({ error: "outbound caller ID is misconfigured" }, 503);
  }
  const conversationId = parsed.data.conversationId ?? crypto.randomUUID();
  const streamUrl = mediaStreamUrl(c);
  const twiml = buildRealtimeVoiceTwiML({
    streamUrl,
    calledNumber: mapping.phoneNumber,
    conversationId,
    greeting: "Hi, this is Eliza calling. You're connected now.",
  });

  try {
    const call = await twilioApiRequest<TwilioCallResponse>(
      accountSid,
      authToken,
      "POST",
      "/Calls.json",
      new URLSearchParams({
        To: parsed.data.to,
        From: from,
        Twiml: twiml,
      }),
    );
    logger.info("[twilio-voice-calls] outbound call started", {
      callSid: call.sid,
      organizationId: user.organization_id,
      agentId: sandbox.id,
      to: parsed.data.to,
      from,
    });
    return c.json(
      {
        callSid: call.sid,
        status: call.status,
        to: call.to,
        from: call.from,
        conversationId,
      },
      201,
    );
  } catch (error) {
    // error-policy:J1 the authenticated HTTP route translates Twilio failures
    // into a retryable gateway response without leaking account credentials.
    logger.error("[twilio-voice-calls] Twilio call creation failed", {
      organizationId: user.organization_id,
      agentId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Twilio could not start the call" }, 502);
  }
});

export default app;
