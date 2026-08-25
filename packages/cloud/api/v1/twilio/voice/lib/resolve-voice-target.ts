/**
 * Resolves the exact public eliza.app line into the caller's account-native
 * personal Shared agent. The trusted Twilio boundary supplies the E.164 caller.
 */

import { resolvePersonalDeliveryProjection } from "@/api-app/personal-delivery-projection";
import { elizaAppUserService } from "@/lib/services/eliza-app/user-service";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { SharedRuntimeAgent } from "@/lib/services/shared-runtime/shared-runtime-agent";

export interface TwilioVoiceTarget {
  agent: SharedRuntimeAgent;
  agentId: string;
  organizationId: string;
  resolution:
    | "sender-projection-hit"
    | "single-query-repeat"
    | "exact-dedicated-fallback"
    | "locked-create-or-repair";
  userId: string;
}

interface PublicElizaVoiceEnv {
  ELIZA_APP_TWILIO_PHONE_NUMBER?: string;
  PERSONAL_DELIVERY_PROJECTIONS?: Parameters<
    typeof resolvePersonalDeliveryProjection
  >[0]["PERSONAL_DELIVERY_PROJECTIONS"];
  PERSONAL_DELIVERY_PROJECTION_READ_ENABLED?: string;
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

  const account = await resolvePersonalDeliveryProjection(
    env as Parameters<typeof resolvePersonalDeliveryProjection>[0],
    { platform: "phone", phoneNumber: callerNumber },
    elizaAppUserService,
  );
  const agent = personalSharedAgent({
    userId: account.userId,
    organizationId: account.organizationId,
  });
  return {
    agent,
    agentId: agent.id,
    organizationId: account.organizationId,
    resolution: account.resolution,
    userId: account.userId,
  };
}
