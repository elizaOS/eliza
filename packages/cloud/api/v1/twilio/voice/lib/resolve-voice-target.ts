/**
 * Resolves the exact public eliza.app line into the caller's account-native
 * personal Shared agent. The trusted Twilio boundary supplies the E.164 caller.
 */

import { elizaAppUserService } from "@elizaos/cloud-shared/lib/services/eliza-app/user-service";
import { personalSharedAgent } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
import type { SharedRuntimeAgent } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-agent";

export interface TwilioVoiceTarget {
  agent: SharedRuntimeAgent;
  agentId: string;
  organizationId: string;
  userId: string;
}

interface PublicElizaVoiceEnv {
  ELIZA_APP_TWILIO_PHONE_NUMBER?: string;
}

export async function resolveTwilioVoiceTarget(
  env: PublicElizaVoiceEnv,
  calledNumber: string,
  callerNumber: string,
): Promise<TwilioVoiceTarget | null> {
  const publicPhoneNumber = env.ELIZA_APP_TWILIO_PHONE_NUMBER?.trim();
  if (!publicPhoneNumber || publicPhoneNumber !== calledNumber) {
    return null;
  }

  const account = await elizaAppUserService.findOrCreateByPhone(callerNumber);
  const agent = personalSharedAgent({
    userId: account.user.id,
    organizationId: account.organization.id,
  });
  return {
    agent,
    agentId: agent.id,
    organizationId: account.organization.id,
    userId: account.user.id,
  };
}
