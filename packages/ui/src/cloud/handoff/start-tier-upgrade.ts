/**
 * Chat-continuity leg of the user-initiated shared→dedicated tier upgrade
 * (#15355). The cloud console calls `POST /api/v1/eliza/agents/:id/upgrade-tier`
 * to mint + provision the dedicated migration target, then hands the pair of
 * agent ids to this module, which reuses the onboarding handoff stack —
 * `startCloudAgentHandoff` polls the dedicated record until its container is
 * reachable, then idempotently imports the shared transcript (canonical
 * conversation id === shared agent id) — and, ONLY on a confirmed switch,
 * deletes the transient shared bridge so the org is not left holding two
 * agents. On `timed-out`/`failed` the shared agent is untouched and keeps
 * serving; re-running is safe (the route reattaches to the same target and the
 * import is idempotent per conversation).
 */

import { buildCloudSharedAgentApiBase } from "../../utils/cloud-agent-base";
import type { ConversationHandoffResult } from "./conversation-handoff";

/**
 * The two client methods the upgrade handoff drives. Deliberately a structural
 * type (satisfied by `ElizaClient`) instead of a `Pick` of it: consumers
 * outside this package (the cloud-e2e suite imports this module by relative
 * source path) must not drag the whole `../../api` type graph in, and unit
 * tests double it directly.
 */
export interface TierUpgradeHandoffClient {
  startCloudAgentHandoff(options: {
    agentId: string;
    sharedApiBase: string;
    conversationId: string;
    cloudApiBase: string;
    authToken: string;
    dedicatedAgentId?: string;
    onSwitch: (containerBase: string) => void | Promise<void>;
    intervalMs?: number;
    timeoutMs?: number;
    log?: (message: string) => void;
  }): Promise<ConversationHandoffResult>;
  deleteSharedBridgeAgent(
    agentId: string,
    options: { cloudApiBase: string; authToken: string },
  ): Promise<{ success: boolean; error?: string }>;
}

export interface TierUpgradeHandoffParams {
  /** The shared agent the user has been chatting on (conversation source). */
  sharedAgentId: string;
  /** The dedicated migration target minted by the upgrade-tier route. */
  dedicatedAgentId: string;
  /** Resolved direct-cloud API origin (NOT a web/auth host). */
  cloudApiBase: string;
  /** Cloud bearer token; both the shared adapter and the dedicated proxy accept it. */
  authToken: string;
  client: TierUpgradeHandoffClient;
  /** Fires with the dedicated container base once the switch is confirmed. */
  onSwitch?: (containerBase: string) => void | Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface TierUpgradeHandoffOutcome {
  status: ConversationHandoffResult["status"];
  /** Messages copied into the dedicated agent (0 on idempotent re-run). */
  imported: number;
  /** True only when the shared bridge row was confirmed deleted. */
  sharedBridgeDeleted: boolean;
  error?: string;
}

/**
 * Run the readiness-poll → transcript-import → switch leg of a tier upgrade
 * and, on a confirmed `switched`/`switched-empty`, delete the shared bridge.
 *
 * The delete is deliberately awaited and reported (`sharedBridgeDeleted`)
 * rather than fire-and-forget: the console surfaces the leaked-row case to the
 * user (the shared agent stays visible in their list) instead of silently
 * leaving a duplicate. A failed delete never un-switches the upgrade — the
 * outcome status stays authoritative for what the user is now running on.
 */
export async function runSharedToDedicatedUpgradeHandoff(
  params: TierUpgradeHandoffParams,
): Promise<TierUpgradeHandoffOutcome> {
  const sharedApiBase = buildCloudSharedAgentApiBase(
    params.cloudApiBase,
    params.sharedAgentId,
  );

  const result = await params.client.startCloudAgentHandoff({
    agentId: params.sharedAgentId,
    dedicatedAgentId: params.dedicatedAgentId,
    sharedApiBase,
    conversationId: params.sharedAgentId,
    cloudApiBase: params.cloudApiBase,
    authToken: params.authToken,
    onSwitch: async (containerBase) => {
      await params.onSwitch?.(containerBase);
    },
    ...(typeof params.intervalMs === "number"
      ? { intervalMs: params.intervalMs }
      : {}),
    ...(typeof params.timeoutMs === "number"
      ? { timeoutMs: params.timeoutMs }
      : {}),
    ...(params.log ? { log: params.log } : {}),
  });

  if (result.status !== "switched" && result.status !== "switched-empty") {
    // Not switched: the user is still served by the shared agent, so the
    // bridge MUST survive — deleting it here would destroy their conversation.
    return {
      status: result.status,
      imported: result.imported,
      sharedBridgeDeleted: false,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  const deletion = await params.client.deleteSharedBridgeAgent(
    params.sharedAgentId,
    {
      cloudApiBase: params.cloudApiBase,
      authToken: params.authToken,
    },
  );

  return {
    status: result.status,
    imported: result.imported,
    sharedBridgeDeleted: deletion.success,
    ...(deletion.success ? {} : { error: deletion.error }),
  };
}
