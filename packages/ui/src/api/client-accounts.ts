/**
 * Extends the dashboard client with account capability metadata and explicit
 * cross-provider routing without coupling those contracts to agent controls.
 */
import type { LinkedAccountProviderId } from "@elizaos/shared";
import type {
  AccountsListProvider,
  AccountsListResponse,
} from "./client-agent";
import { ElizaClient } from "./client-base";

export interface ProviderRuntimeEligibility {
  chat: boolean;
  codingAgent: boolean;
  note?: string;
}

export interface ProviderSelectionState {
  activeAccountId: string | null;
  reason:
    | "reset-soonest"
    | "only-eligible"
    | "priority"
    | "round-robin"
    | "least-used"
    | "quota-aware"
    | "least-recently-throttled"
    | null;
}

export type AccountUseCaseId = "chat" | "codingAgent";

export interface AccountRoutingTier {
  providerId: LinkedAccountProviderId;
  accountId?: string;
}

export type RoutingTierStatus = "available" | "throttled" | "unavailable";

export interface ResolvedRoutingTier extends AccountRoutingTier {
  status: RoutingTierStatus;
  /** Milliseconds since the Unix epoch when a throttled tier can recover. */
  resetsAt?: number;
}

export type AccountRoutingView = Record<
  AccountUseCaseId,
  ResolvedRoutingTier[]
>;

declare module "./client-agent" {
  interface AccountsListProvider {
    runtimeEligibility?: ProviderRuntimeEligibility;
    selection?: ProviderSelectionState;
  }

  interface AccountsListResponse {
    routing?: AccountRoutingView;
  }
}

declare module "./client-base" {
  interface ElizaClient {
    putUseCaseRouting(body: {
      useCase: AccountUseCaseId;
      tiers: AccountRoutingTier[];
    }): Promise<{
      useCase: AccountUseCaseId;
      tiers: AccountRoutingTier[];
    }>;
  }
}

ElizaClient.prototype.putUseCaseRouting = async function (
  this: ElizaClient,
  body,
) {
  return this.fetch("/api/accounts/routing", {
    method: "PUT",
    body: JSON.stringify(body),
  });
};

export type { AccountsListProvider, AccountsListResponse };
