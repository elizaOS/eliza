/** Service-backed Network effects; Cloud never owns a parallel membership/state store. */
import {
  createServiceNetworkStore,
  type NetworkAppId,
  type NetworkRouting,
  NetworkServiceClient,
  type NetworkStore,
  parseServiceTurn,
} from "@elizaos/plugin-network";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import {
  isVerifiedNetworkAdmission,
  type VerifiedNetworkAdmission,
} from "../services/shared-runtime/network-shared-admission";
import {
  isCanonicalPersonalSharedAgent,
  personalSharedProjectScope,
} from "../services/shared-runtime/personal-shared-identity";
import type { SharedRuntimeAgent } from "../services/shared-runtime/shared-runtime-agent";

export function serviceNetworkStoreFactory(
  trustedNetworkTurn: unknown,
  env: Record<string, string | undefined> = getCloudAwareEnv(),
): ((() => NetworkStore) & { readonly app?: NetworkAppId }) | undefined {
  const admission = isVerifiedNetworkAdmission(trustedNetworkTurn) ? trustedNetworkTurn : undefined;
  const turn = parseServiceTurn(admission ? admission.turn : trustedNetworkTurn);
  const baseUrl = env.NETWORK_SERVICE_URL?.trim();
  const secret = env.SERVICE_TURN_SECRET;
  if (!turn || !baseUrl || !secret) return undefined;
  const client = new NetworkServiceClient({ baseUrl, secret });
  const factory = () =>
    createServiceNetworkStore(client, turn, {
      relayEnabled: env.NETWORK_RELAY_ENABLED?.trim() === "1",
    });
  return admission ? Object.assign(factory, { app: turn.app }) : factory;
}

/**
 * The character flag (NETWORK_AGENT_VOICE=1, off by default): the app whose voice the shared agent
 * speaks in for this service-admitted open turn. Undefined leaves the Eliza character unchanged.
 */
export function networkVoiceApp(
  trustedNetworkTurn: unknown,
  env: Record<string, string | undefined> = getCloudAwareEnv(),
): NetworkAppId | undefined {
  if (env.NETWORK_AGENT_VOICE?.trim() !== "1") return undefined;
  const turn = isVerifiedNetworkAdmission(trustedNetworkTurn)
    ? trustedNetworkTurn.turn
    : trustedNetworkTurn;
  return parseServiceTurn(turn)?.app;
}

export function sharedNetworkExecution(
  agent: Pick<
    SharedRuntimeAgent,
    "id" | "organization_id" | "user_id" | "execution_tier" | "project"
  >,
  personalShared: boolean,
  isNoncanonicalRoom: boolean,
  storeFactory: ((() => NetworkStore) & { readonly app?: NetworkAppId }) | undefined,
  routing?: NetworkRouting,
  voiceApp?: NetworkAppId,
  admission?: VerifiedNetworkAdmission,
):
  | {
      memberId: string;
      app?: NetworkAppId;
      store: NetworkStore;
      routing?: NetworkRouting;
      voiceApp?: NetworkAppId;
    }
  | undefined {
  if (
    !storeFactory ||
    !personalShared ||
    isNoncanonicalRoom ||
    !isCanonicalPersonalSharedAgent(agent) ||
    (admission !== undefined
      ? !isVerifiedNetworkAdmission(admission) ||
        storeFactory.app !== parseServiceTurn(admission.turn)?.app
      : personalSharedProjectScope(agent.project) !== "network")
  )
    return undefined;
  return {
    memberId: agent.user_id,
    ...(admission ? { app: storeFactory.app } : {}),
    store: storeFactory(),
    ...(routing ? { routing } : {}),
    ...(voiceApp ? { voiceApp } : {}),
  };
}
