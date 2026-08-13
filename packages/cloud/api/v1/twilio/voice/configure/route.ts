/**
 * Verifies an account-owned Twilio number, binds it to a user-owned Eliza
 * agent, and programs its inbound voice webhook as one authenticated operation.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead, dbWrite } from "@/db/helpers";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { agentPhoneNumbers } from "@/db/schemas";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import { isE164PhoneNumber, twilioApiRequest } from "@/lib/utils/twilio-api";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const ConfigureVoiceSchema = z.object({
  agentId: z.string().uuid(),
  phoneNumber: z
    .string()
    .refine(isE164PhoneNumber, "phoneNumber must be in E.164 format"),
});

interface TwilioIncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  capabilities?: { voice?: boolean };
}

interface TwilioIncomingNumbersResponse {
  incoming_phone_numbers: TwilioIncomingNumber[];
}

function inboundWebhookUrl(c: AppContext): string {
  const configured = (c.env.TWILIO_PUBLIC_URL as string | undefined)?.trim();
  const url = new URL(configured || c.req.url);
  url.pathname = "/api/v1/twilio/voice/inbound";
  url.search = "";
  url.protocol = url.protocol === "http:" ? "http:" : "https:";
  return url.toString();
}

app.post("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  let requestBody: unknown;
  try {
    requestBody = await c.req.json();
  } catch {
    // error-policy:J3 malformed JSON is explicit invalid input, never a
    // defaulted voice configuration.
    return c.json({ error: "invalid voice configuration" }, 400);
  }
  const parsed = ConfigureVoiceSchema.safeParse(requestBody);
  if (!parsed.success) {
    return c.json(
      { error: "invalid voice configuration", issues: parsed.error.issues },
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

  let remoteNumber: TwilioIncomingNumber;
  try {
    const result = await twilioApiRequest<TwilioIncomingNumbersResponse>(
      accountSid,
      authToken,
      "GET",
      `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(parsed.data.phoneNumber)}`,
    );
    const match = result.incoming_phone_numbers.find(
      (number) => number.phone_number === parsed.data.phoneNumber,
    );
    if (!match) {
      return c.json(
        { error: "phone number is not owned by this Twilio account" },
        404,
      );
    }
    if (match.capabilities?.voice !== true) {
      return c.json({ error: "Twilio number is not voice capable" }, 409);
    }
    remoteNumber = match;
  } catch (error) {
    // error-policy:J1 the authenticated route translates Twilio lookup failure
    // without exposing the organization-scoped credential or provider payload.
    logger.error("[twilio-voice-configure] number verification failed", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Twilio could not verify the phone number" }, 502);
  }

  const [existing] = await dbRead
    .select({ agentId: agentPhoneNumbers.agent_id })
    .from(agentPhoneNumbers)
    .where(
      and(
        eq(agentPhoneNumbers.organization_id, user.organization_id),
        eq(agentPhoneNumbers.phone_number, parsed.data.phoneNumber),
      ),
    )
    .limit(1);
  if (existing && existing.agentId !== sandbox.id) {
    return c.json(
      { error: "phone number is already assigned to another agent" },
      409,
    );
  }

  const webhookUrl = inboundWebhookUrl(c);
  try {
    await twilioApiRequest(
      accountSid,
      authToken,
      "POST",
      `/IncomingPhoneNumbers/${encodeURIComponent(remoteNumber.sid)}.json`,
      new URLSearchParams({ VoiceUrl: webhookUrl, VoiceMethod: "POST" }),
    );
  } catch (error) {
    // error-policy:J1 do not persist a healthy-looking local binding when the
    // provider rejected its webhook; the caller can retry after the 502.
    logger.error("[twilio-voice-configure] webhook programming failed", {
      organizationId: user.organization_id,
      phoneNumber: parsed.data.phoneNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { error: "Twilio could not configure the voice webhook" },
      502,
    );
  }

  const now = new Date();
  const [mapping] = await dbWrite
    .insert(agentPhoneNumbers)
    .values({
      organization_id: user.organization_id,
      agent_id: sandbox.id,
      phone_number: parsed.data.phoneNumber,
      friendly_name: remoteNumber.friendly_name ?? "Eliza voice",
      provider: "twilio",
      phone_type: "both",
      provider_phone_id: remoteNumber.sid,
      webhook_url: webhookUrl,
      webhook_configured: true,
      is_active: true,
      verified: true,
      verified_at: now,
      can_voice: true,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        agentPhoneNumbers.phone_number,
        agentPhoneNumbers.organization_id,
      ],
      set: {
        agent_id: sandbox.id,
        friendly_name: remoteNumber.friendly_name ?? "Eliza voice",
        provider: "twilio",
        phone_type: "both",
        provider_phone_id: remoteNumber.sid,
        webhook_url: webhookUrl,
        webhook_configured: true,
        is_active: true,
        verified: true,
        verified_at: now,
        can_voice: true,
        updated_at: now,
      },
    })
    .returning({ id: agentPhoneNumbers.id });

  logger.info("[twilio-voice-configure] voice number configured", {
    organizationId: user.organization_id,
    userId: user.id,
    agentId: sandbox.id,
    phoneNumber: parsed.data.phoneNumber,
    providerPhoneId: remoteNumber.sid,
  });
  return c.json({
    success: true,
    mappingId: mapping.id,
    agentId: sandbox.id,
    phoneNumber: parsed.data.phoneNumber,
    webhookUrl,
  });
});

export default app;
