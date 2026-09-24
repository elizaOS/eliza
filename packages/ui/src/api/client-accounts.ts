/**
 * Extends the dashboard client with server-authoritative account capability
 * and selection metadata without coupling those contracts to agent controls.
 */
import type { ProviderRuntimeEligibility } from "@elizaos/shared";
import type {
  AccountsListProvider,
  AccountsListResponse,
} from "./client-agent";

export type { ProviderRuntimeEligibility } from "@elizaos/shared";

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

/**
 * Per-account lease/observability surfaced by the localhost pool broker
 * (#16355). Optional end-to-end: older agent hosts (and the broker-absent
 * path) omit it entirely, so every consumer must feature-detect and degrade
 * gracefully rather than assume these fields exist.
 */
export interface AccountLeaseObservability {
  /** Leases currently checked out against this account. */
  activeLeaseCount: number;
  /** epoch ms of the most recent lease grant, or null if never leased. */
  lastLeaseAt: number | null;
  /** epoch ms the broker last *selected* this account, or null. */
  lastSelectedAt: number | null;
  /** True when this account served the provider's most recent request. */
  servedLastRequest: boolean;
}

/** Provider-level broker telemetry (last pick + recent failovers). */
export interface ProviderLeaseObservability {
  lastSelection: {
    accountId: string;
    atMs: number;
  } | null;
  recentFailovers: Array<{
    fromAccountId: string;
    toAccountId: string;
    atMs: number;
    cause: string;
  }>;
}

declare module "./client-agent" {
  interface AccountsListProvider {
    runtimeEligibility?: ProviderRuntimeEligibility;
    selection?: ProviderSelectionState;
    observability?: ProviderLeaseObservability;
  }

  interface AccountWithCredentialFlag {
    observability?: AccountLeaseObservability;
  }
}

export type { AccountsListProvider, AccountsListResponse };
