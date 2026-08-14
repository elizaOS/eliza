/**
 * Chat-continuity leg of the user-initiated shared→dedicated tier upgrade
 * (#15355). The cloud console calls `POST /api/v1/eliza/agents/:id/upgrade-tier`
 * to mint + provision the dedicated migration target, then hands the pair of
 * agent ids to this module, which reuses the onboarding handoff stack —
 * `startCloudAgentHandoff` polls the dedicated record until its container is
 * reachable, then idempotently imports the shared transcript (canonical
 * conversation id === shared agent id) — and, ONLY on a confirmed switch,
 * finalizes the server-owned active-runtime marker. Rowless personal Shared
 * history remains as the fallback/archive; only the legacy row-backed bridge
 * is deleted after a confirmed switch. On `timed-out`/`failed` Shared remains
 * authoritative and keeps serving. Re-running is safe because target creation
 * and transcript import are idempotent.
 */

import {
  buildCloudSharedAgentApiBase,
  isPersonalSharedElizaId,
} from "../../utils/cloud-agent-base";
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
  finalizePersonalDedicatedCutover(options: {
    personalElizaId: string;
    dedicatedAgentId: string;
    cloudApiBase: string;
    authToken: string;
  }): Promise<{ runtime: "dedicated"; apiBase: string }>;
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
  /** How the Shared source was left after the switch attempt. */
  sourceCleanup:
    | "unchanged"
    | "preserved-rowless"
    | "deleted-row"
    | "not-cleaned";
  error?: string;
}

/**
 * Run the readiness-poll → transcript-import → server-finalize → switch leg.
 * Personal Shared has no row to delete and remains a durable archive/fallback;
 * the exact active-runtime marker prevents subsequent phone or app turns from
 * splitting across modes. The legacy bridge delete is still awaited and
 * reported so a leaked row remains visible rather than silently duplicating
 * the switched agent.
 */
export async function runSharedToDedicatedUpgradeHandoff(
  params: TierUpgradeHandoffParams,
): Promise<TierUpgradeHandoffOutcome> {
  const sharedApiBase = buildCloudSharedAgentApiBase(
    params.cloudApiBase,
    params.sharedAgentId,
  );
  const rowlessPersonal = isPersonalSharedElizaId(params.sharedAgentId);

  const result = await params.client.startCloudAgentHandoff({
    agentId: params.sharedAgentId,
    dedicatedAgentId: params.dedicatedAgentId,
    sharedApiBase,
    conversationId: params.sharedAgentId,
    cloudApiBase: params.cloudApiBase,
    authToken: params.authToken,
    onSwitch: async (containerBase) => {
      if (rowlessPersonal) {
        await params.client.finalizePersonalDedicatedCutover({
          personalElizaId: params.sharedAgentId,
          dedicatedAgentId: params.dedicatedAgentId,
          cloudApiBase: params.cloudApiBase,
          authToken: params.authToken,
        });
      }
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
      sourceCleanup: "unchanged",
      ...(result.error ? { error: result.error } : {}),
    };
  }

  if (rowlessPersonal) {
    return {
      status: result.status,
      imported: result.imported,
      sourceCleanup: "preserved-rowless",
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
    sourceCleanup: deletion.success ? "deleted-row" : "not-cleaned",
    ...(deletion.success ? {} : { error: deletion.error }),
  };
}
