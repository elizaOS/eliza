/**
 * Resolves the exact public eliza.app line into a call-isolated guest agent.
 * Twilio attests transport metadata, not account ownership, so caller ID never
 * selects an existing user's personal history or verifies their phone number.
 */

import { v5 as uuidv5 } from "uuid";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { SharedRuntimeAgent } from "@/lib/services/shared-runtime/shared-runtime-agent";

const TWILIO_VOICE_GUEST_NAMESPACE = "cc6c1466-69bb-4bc7-96c3-2da07909ca17";
const GUEST_ORGANIZATION_ID = "anonymous";

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
  callIdentity: { accountSid: string; callSid: string },
): Promise<TwilioVoiceTarget | null> {
  const publicPhoneNumber = env.ELIZA_APP_TWILIO_PHONE_NUMBER?.trim();
  if (!publicPhoneNumber || publicPhoneNumber !== calledNumber) {
    return null;
  }

  const userId = uuidv5(
    `${callIdentity.accountSid.trim()}:${callIdentity.callSid.trim()}`,
    TWILIO_VOICE_GUEST_NAMESPACE,
  );
  const personalProjection = personalSharedAgent({
    userId,
    organizationId: GUEST_ORGANIZATION_ID,
  });
  // A UUID agent id deliberately keeps this platform-funded guest outside the
  // canonical `personal:` namespace that enables account-only capabilities.
  const agent = { ...personalProjection, id: userId };
  return {
    agent,
    agentId: agent.id,
    organizationId: GUEST_ORGANIZATION_ID,
    userId,
  };
}
