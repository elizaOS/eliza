/**
 * Structural contract consumed by the cloud team-credential pool. The cloud
 * implementation keeps selection metadata dependency-injected so the same pool
 * logic can run over Drizzle rows without coupling to self-host runtime state.
 */
import type { LinkedAccountConfig } from "@elizaos/contracts";

export type Strategy = "priority" | "round-robin" | "least-used" | "quota-aware";

export type PoolProviderId = LinkedAccountConfig["providerId"];

export interface SelectInput {
  providerId: PoolProviderId;
  sessionKey?: string;
  strategy?: Strategy;
  accountIds?: string[];
  exclude?: string[];
}

export interface AccountPoolDeps {
  readAccounts: () => Record<string, LinkedAccountConfig>;
  writeAccount: (account: LinkedAccountConfig) => Promise<void>;
  deleteAccount?: (providerId: PoolProviderId, accountId: string) => Promise<void>;
}

export interface AccountPool {
  select(input: SelectInput): Promise<LinkedAccountConfig | null>;
  list(providerId?: PoolProviderId): LinkedAccountConfig[];
  get(accountId: string, providerId?: PoolProviderId): LinkedAccountConfig | null;
  markRateLimited(
    accountId: string,
    untilMs: number,
    detail?: string,
    opts?: { providerId?: PoolProviderId },
  ): Promise<void>;
  markNeedsReauth(
    accountId: string,
    detail?: string,
    opts?: { providerId?: PoolProviderId },
  ): Promise<void>;
  reprobeFlagged(): Promise<string[]>;
}
