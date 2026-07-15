/**
 * Extends the dashboard client with server-authoritative account capability
 * and selection metadata without coupling those contracts to agent controls.
 */
import type {
  AccountsListProvider,
  AccountsListResponse,
} from "./client-agent";

export interface ProviderRuntimeEligibility {
  chat: boolean;
  codingAgent: boolean;
  note?: string;
}

export interface ProviderSelectionState {
  activeAccountId: string | null;
  reason:
    | "reset-soonest"
    | "drain-soonest-reset"
    | "only-eligible"
    | "priority"
    | "round-robin"
    | "least-used"
    | "quota-aware"
    | "least-recently-throttled"
    | null;
}

declare module "./client-agent" {
  interface AccountsListProvider {
    runtimeEligibility?: ProviderRuntimeEligibility;
    selection?: ProviderSelectionState;
  }
}

export type { AccountsListProvider, AccountsListResponse };
