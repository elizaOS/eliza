/**
 * Routes a normalized personal connector turn to the user's active Dedicated
 * runtime when present, otherwise to their rowless personal Shared runtime.
 * A Dedicated target whose entitlement was withdrawn (lapsed paid plan or a
 * confirmed, unfunded billing stop) is answered by Shared in a separately
 * scoped fallback journal (#25146), which is reconciled back into Dedicated
 * before routing returns.
 */

import { ChannelType } from "@elizaos/core";
import type { Organization } from "../../db/schemas/organizations";
import type { User } from "../../db/schemas/users";
import type { AppEnv, RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { findActivePersonalDedicatedTarget } from "./agent-tier-upgrade-target";
import { elizaSandboxService } from "./eliza-sandbox";
import { repairPersonalConversation } from "./personal-conversation-repair";
import { preparePersonalDedicatedDelivery } from "./personal-dedicated-delivery";
import {
  type PersonalSharedFallbackAccountState,
  type PersonalSharedFallbackDelivery,
  resolvePersonalDedicatedRoute,
} from "./personal-dedicated-fallback";
import { reconcilePersonalFallbackIntoDedicated } from "./personal-dedicated-fallback-reconcile";
import { coordinateSharedHistory } from "./shared-runtime/conversation-coordinator";
import { personalSharedAgent } from "./shared-runtime/personal-shared-agent";
import { sharedRestMessageSend } from "./shared-runtime/shared-rest-adapter";

export interface PersonalMessageAccount {
  user: User;
  organization: Organization;
}

export type PersonalMessageDeliveryResult =
  | {
      success: true;
      identity: { id: string; runtime: "shared" | "dedicated"; activeAgentId?: string };
      account: { userId: string; organizationId: string };
      reply: string;
      /** Present only while Dedicated access is withdrawn (#25146). */
      accountState?: PersonalSharedFallbackAccountState;
    }
  | {
      success: false;
      status: 402 | 428 | 502 | 503;
      code: string;
      error: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      currentBalance?: number;
      data?: Record<string, unknown>;
    };

export async function deliverPersonalTextMessage(params: {
  account: PersonalMessageAccount;
  message: string;
  messageId: string;
  platform: string;
  senderName?: string;
  env: AppEnv["Bindings"];
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  namespace: RuntimeDurableObjectNamespace;
}): Promise<PersonalMessageDeliveryResult> {
  const { account } = params;
  const agent = personalSharedAgent({
    userId: account.user.id,
    organizationId: account.organization.id,
  });
  const dedicated = await findActivePersonalDedicatedTarget(
    account.organization.id,
    account.user.id,
    agent.id,
  );
  let sharedFallback: PersonalSharedFallbackDelivery | null = null;
  if (dedicated) {
    // One entitlement/route authority decides the single active destination.
    const route = await resolvePersonalDedicatedRoute({
      dedicated,
      organizationId: account.organization.id,
      userId: account.user.id,
      sourceAgentId: agent.id,
    });
    if (route.route === "unavailable") {
      return {
        success: false,
        status: route.status,
        code: route.code,
        error: route.error,
        retryable: route.retryable,
        retryAfterSeconds: route.retryAfterSeconds,
      };
    }
    if (route.route === "shared_fallback") {
      sharedFallback = route.delivery;
    } else {
      const preparation = await preparePersonalDedicatedDelivery(dedicated);
      if (preparation.state === "unavailable") {
        return {
          success: false,
          status: preparation.status,
          code: preparation.code,
          error: preparation.error,
          retryable: preparation.retryable,
          retryAfterSeconds: preparation.retryAfterSeconds,
        };
      }
      if (route.reconcile) {
        // The recovered Shared interval reaches Dedicated before routing
        // returns, so the two runtimes never both own the conversation.
        const reconciled = await reconcilePersonalFallbackIntoDedicated({
          fallback: route.reconcile,
          namespace: params.namespace,
        });
        if (!reconciled.reconciled) {
          return {
            success: false,
            status: 503,
            code: "dedicated_reconciling",
            error: "Dedicated Eliza is restoring your recent conversation. Try again shortly.",
            retryable: true,
            retryAfterSeconds: 5,
          };
        }
      }
    }
  }
  if (dedicated && !sharedFallback) {
    const bridgeRequest = {
      jsonrpc: "2.0" as const,
      id: params.messageId,
      method: "message.send",
      params: {
        text: params.message,
        roomId: agent.id,
        conversationId: agent.id,
        canonicalBridgeBase: dedicated.bridge_url,
        userId: account.user.id,
        clientMessageId: params.messageId,
        platformName: params.platform,
        source: params.platform,
        ...(params.senderName ? { senderName: params.senderName } : {}),
      },
    };
    let response = await elizaSandboxService.bridge(
      dedicated.id,
      account.organization.id,
      bridgeRequest,
    );
    if (response.error?.message === "Bridge returned HTTP 404") {
      const history = await coordinateSharedHistory(agent.id, agent.id, {
        namespace: params.namespace,
      });
      const repaired = await repairPersonalConversation(history, (messages) =>
        elizaSandboxService.importCanonicalConversation(
          dedicated.id,
          account.organization.id,
          agent.id,
          messages,
        ),
      );
      if (repaired) {
        response = await elizaSandboxService.bridge(
          dedicated.id,
          account.organization.id,
          bridgeRequest,
        );
      }
    }
    const result = response.result as { text?: unknown } | undefined;
    if (response.error || typeof result?.text !== "string") {
      return {
        success: false,
        status: 503,
        code: "service_unavailable",
        error: "Dedicated Eliza is temporarily unavailable.",
        retryable: true,
      };
    }
    return {
      success: true,
      identity: { id: agent.id, runtime: "dedicated", activeAgentId: dedicated.id },
      account: { userId: account.user.id, organizationId: account.organization.id },
      reply: result.text,
    };
  }

  const result = await sharedRestMessageSend(
    agent,
    // The fallback journal is a new scoped room: Shared never reads the
    // canonical Dedicated or pre-upgrade conversation while access is withdrawn.
    sharedFallback?.journalRoomId ?? agent.id,
    params.message,
    agent.agent_name ?? "Eliza",
    params.executionCtx,
    params.namespace,
    params.messageId,
    "platform",
    undefined,
    params.message,
    { type: ChannelType.DM, source: params.platform },
    sharedFallback?.accountState,
  );
  return {
    success: true,
    identity: { id: agent.id, runtime: "shared" },
    account: { userId: account.user.id, organizationId: account.organization.id },
    reply: result.text,
    ...(sharedFallback ? { accountState: sharedFallback.accountState } : {}),
  };
}
