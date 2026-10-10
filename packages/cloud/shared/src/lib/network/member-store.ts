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
  isCanonicalPersonalSharedAgent,
  personalSharedProjectScope,
} from "../services/shared-runtime/personal-shared-identity";
import type { SharedRuntimeAgent } from "../services/shared-runtime/shared-runtime-agent";

export function serviceNetworkStoreFactory(
  trustedNetworkTurn: unknown,
  env: Record<string, string | undefined> = getCloudAwareEnv(),
): (() => NetworkStore) | undefined {
  const turn = parseServiceTurn(trustedNetworkTurn);
  const baseUrl = env.NETWORK_SERVICE_URL?.trim();
  const secret = env.SERVICE_TURN_SECRET;
  if (!turn || !baseUrl || !secret) return undefined;
  const client = new NetworkServiceClient({ baseUrl, secret });
  return () => createServiceNetworkStore(client, turn);
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
  return parseServiceTurn(trustedNetworkTurn)?.app;
}

export function sharedNetworkExecution(
  agent: Pick<
    SharedRuntimeAgent,
    "id" | "organization_id" | "user_id" | "execution_tier" | "project"
  >,
  personalShared: boolean,
  isNoncanonicalRoom: boolean,
  storeFactory: (() => NetworkStore) | undefined,
  routing?: NetworkRouting,
  voiceApp?: NetworkAppId,
):
  | {
      memberId: string;
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
    personalSharedProjectScope(agent.project) !== "network"
  )
    return undefined;
  return {
    memberId: agent.user_id,
    store: storeFactory(),
    ...(routing ? { routing } : {}),
    ...(voiceApp ? { voiceApp } : {}),
  };
}
