/**
 * Resolves a called Twilio number to either an explicit tenant binding or the
 * narrowly configured public eliza.app default agent.
 */

import { and, eq } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { agentPhoneNumbers } from "@/db/schemas";

export interface TwilioVoiceTarget {
  agentId: string;
  organizationId: string;
  userId: string;
}

interface PublicElizaVoiceEnv {
  ELIZA_APP_DEFAULT_AGENT_ID?: string;
  ELIZA_APP_TWILIO_PHONE_NUMBER?: string;
}

export async function resolveTwilioVoiceTarget(
  env: PublicElizaVoiceEnv,
  calledNumber: string,
): Promise<TwilioVoiceTarget | null> {
  const [mapping] = await dbRead
    .select({
      agentId: agentPhoneNumbers.agent_id,
      organizationId: agentPhoneNumbers.organization_id,
    })
    .from(agentPhoneNumbers)
    .where(
      and(
        eq(agentPhoneNumbers.phone_number, calledNumber),
        eq(agentPhoneNumbers.provider, "twilio"),
        eq(agentPhoneNumbers.is_active, true),
        eq(agentPhoneNumbers.can_voice, true),
      ),
    )
    .limit(1);
  if (mapping) {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      mapping.agentId,
      mapping.organizationId,
    );
    return sandbox
      ? {
          agentId: sandbox.id,
          organizationId: mapping.organizationId,
          userId: sandbox.user_id,
        }
      : null;
  }

  const publicPhoneNumber = env.ELIZA_APP_TWILIO_PHONE_NUMBER?.trim();
  const defaultAgentId = env.ELIZA_APP_DEFAULT_AGENT_ID?.trim();
  if (
    !publicPhoneNumber ||
    publicPhoneNumber !== calledNumber ||
    !defaultAgentId
  ) {
    return null;
  }

  const direct = await agentSandboxesRepository.findById(defaultAgentId);
  const sandbox =
    direct ??
    (await agentSandboxesRepository.findLatestByCharacterId(defaultAgentId));
  return sandbox
    ? {
        agentId: sandbox.id,
        organizationId: sandbox.organization_id,
        userId: sandbox.user_id,
      }
    : null;
}
