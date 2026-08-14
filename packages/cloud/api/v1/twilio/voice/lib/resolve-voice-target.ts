/**
 * Resolves only the exact public eliza.app Twilio line to its configured agent.
 */

import {
  type AgentSandbox,
  agentSandboxesRepository,
} from "@/db/repositories/agent-sandboxes";

export interface TwilioVoiceTarget {
  agent: AgentSandbox;
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
        agent: sandbox,
        agentId: sandbox.id,
        organizationId: sandbox.organization_id,
        userId: sandbox.user_id,
      }
    : null;
}
